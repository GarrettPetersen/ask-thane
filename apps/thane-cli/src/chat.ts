import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createHostedChannel, createHostedWorkspace, ensureHostedWorkspace, hasHostedChat, reactHostedMessage, sendHostedMessage, syncHostedStore } from "./hosted.js";
import { renderChannels, renderInbox, renderMessages, renderUsers } from "./render.js";
import { completeSlashCommand, renderSlashCommands, slashCommands } from "./slash-commands.js";
import { ThaneStore } from "./store.js";
import type { ConversationSummary, MessageView, ThaneChannel, ThaneWorkspace } from "./model.js";
import type { SlashCommand } from "./slash-commands.js";
import { checkForUpdate, renderUpdateStatus, type UpdateStatus } from "./update.js";

const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const INVERSE = "\x1b[7m";
const BOLD = "\x1b[1m";

function hostedWorkspaceId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `wsp_${Date.now().toString(36)}${random}`;
}

interface ChatConversation {
  id: string;
  label: string;
  name: string;
  kind: "channel" | "dm";
  unreadCount: number;
  mentionCount: number;
}

interface CompletionCandidate {
  label: string;
  value: string;
}

type ChatFocus = "composer" | "sidebar" | "messages";
type ComposerMode = "message" | "reply" | "react";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🚀"];

function size(): { columns: number; rows: number } {
  return {
    columns: Math.max(60, Number(output.columns ?? 100)),
    rows: Math.max(20, Number(output.rows ?? 30))
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function fit(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) {
    return value + " ".repeat(width - plain.length);
  }
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function workspaceInitials(workspace: ThaneWorkspace): string {
  const words = (workspace.name || workspace.slug)
    .split(/[^a-z0-9]+/i)
    .map((word) => word.trim())
    .filter(Boolean);
  const initials = words.length > 1
    ? words.map((word) => word[0]).join("")
    : (words[0] ?? workspace.slug).slice(0, 4);
  return initials.toUpperCase().slice(0, 4);
}

function renderWorkspaceCrest(workspace: ThaneWorkspace, width: number): string[] {
  if (workspace.asciiArt?.trim()) {
    return [
      ...workspace.asciiArt.split("\n").slice(0, 10).map((line) => fit(line, width)),
      fit(`${BOLD}${workspace.slug}${RESET}`, width),
      fit("", width)
    ];
  }

  if (width < 18) {
    return [fit(`${BOLD}${workspace.slug}${RESET}`, width), fit("", width)];
  }

  const innerWidth = Math.min(width - 2, 26);
  const sidePad = " ".repeat(Math.max(0, Math.floor((width - innerWidth - 2) / 2)));
  const seed = `${workspace.id}:${workspace.slug}:${workspace.name}`;
  const hash = hashString(seed);
  const glyphs = [" ", ".", ":", "+", "*", "#"];
  const motifRows = Array.from({ length: 4 }, (_, row) => {
    const left = Array.from({ length: 4 }, (_, column) => {
      const shift = (row * 7 + column * 5) % 24;
      return glyphs[(hash >>> shift) % glyphs.length] ?? " ";
    });
    return [...left, glyphs[(hash >>> ((row * 11) % 24)) % glyphs.length] ?? " ", ...left.slice().reverse()].join("");
  });
  const title = ` ${workspaceInitials(workspace)} `;
  const titlePad = Math.max(0, innerWidth - title.length);
  const titleLine = `${title}${" ".repeat(titlePad)}`;
  const artPad = Math.max(0, Math.floor((innerWidth - motifRows[0]!.length) / 2));

  return [
    `${sidePad}.${"-".repeat(innerWidth)}.${" ".repeat(width - sidePad.length - innerWidth - 2)}`,
    `${sidePad}|${fit(titleLine, innerWidth)}|${" ".repeat(width - sidePad.length - innerWidth - 2)}`,
    ...motifRows.map((row) => {
      const art = `${" ".repeat(artPad)}${row}`;
      return `${sidePad}|${fit(art, innerWidth)}|${" ".repeat(width - sidePad.length - innerWidth - 2)}`;
    }),
    `${sidePad}'${"-".repeat(innerWidth)}'${" ".repeat(width - sidePad.length - innerWidth - 2)}`,
    fit(`${BOLD}${workspace.slug}${RESET}`, width),
    fit("", width)
  ];
}

function wrap(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + word.length + 1 <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function channelLabel(channel: ThaneChannel): string {
  return channel.kind === "dm" ? `@${channel.name}` : `#${channel.name}`;
}

function conversations(store: ThaneStore, activeId: string): ChatConversation[] {
  const activity = new Map<string, ConversationSummary>(
    store.inbox({ includeQuiet: true }).map((summary) => [summary.conversationId, summary])
  );
  const channels = store.listChannels().map((channel) => {
    const summary = activity.get(channel.id);
    return {
      id: channel.id,
      label: channelLabel(channel),
      name: channel.name,
      kind: channel.kind,
      unreadCount: summary?.unreadCount ?? 0,
      mentionCount: summary?.mentionCount ?? 0
    } satisfies ChatConversation;
  });
  const dms = store.listDms().map((dm) => {
    const summary = activity.get(dm.id);
    return {
      id: dm.id,
      label: channelLabel(dm),
      name: dm.name,
      kind: dm.kind,
      unreadCount: summary?.unreadCount ?? 0,
      mentionCount: summary?.mentionCount ?? 0
    } satisfies ChatConversation;
  });
  const all = [...channels, ...dms];
  if (!all.some((item) => item.id === activeId)) {
    const channel = store.findChannel(activeId);
    if (channel) {
      all.unshift({
        id: channel.id,
        label: channelLabel(channel),
        name: channel.name,
        kind: channel.kind,
        unreadCount: 0,
        mentionCount: 0
      });
    }
  }
  return all;
}

async function selectConversation(store: ThaneStore, target: string): Promise<ThaneChannel> {
  if (target.startsWith("@")) {
    const normalized = target.slice(1).trim().toLowerCase();
    const dm = store.listDms().find((candidate) => candidate.name === normalized);
    if (!dm) {
      throw new Error(`DM ${target} was not found.`);
    }
    return dm;
  }
  const channel = store.findChannel(target.replace(/^#/, ""));
  if (!channel) {
    throw new Error(`Channel ${target} was not found.`);
  }
  return channel;
}

function threadedMessages(messages: MessageView[]): MessageView[] {
  const byRoot = new Map<string, MessageView[]>();
  const roots: MessageView[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.threadRootId) {
      const replies = byRoot.get(message.threadRootId) ?? [];
      replies.push(message);
      byRoot.set(message.threadRootId, replies);
    } else {
      roots.push(message);
      seen.add(message.id);
    }
  }

  const ordered: MessageView[] = [];
  for (const root of roots) {
    ordered.push(root);
    ordered.push(...(byRoot.get(root.id) ?? []));
  }
  for (const message of messages) {
    if (message.threadRootId && !seen.has(message.threadRootId)) {
      ordered.push(message);
    }
  }
  return ordered;
}

function renderMessage(message: MessageView, width: number, selected = false): string[] {
  const date = new Date(message.createdAt);
  const time = Number.isNaN(date.getTime())
    ? message.createdAt
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const isReply = Boolean(message.threadRootId);
  const indent = isReply ? "    " : "";
  const marker = selected ? `${BOLD}>${RESET} ` : "  ";
  const thread = message.replyCount > 0 ? ` ${DIM}(${message.replyCount} replies)${RESET}` : "";
  const reactions = message.reactions.length > 0
    ? ` ${DIM}${message.reactions.map((reaction) => reaction.emoji).join(" ")}${RESET}`
    : "";
  const branch = isReply ? `${DIM}└─${RESET} ` : "";
  const sourceMarker = message.source === "terminal" ? " 🤖" : "";
  const prefix = `${indent}${marker}${branch}${DIM}${time}${RESET} ${BOLD}${message.author}${sourceMarker}${RESET}: `;
  const bodyWidth = Math.max(10, width - visibleLength(prefix));
  const actionHint = selected ? ` ${DIM}r reply · e react${RESET}` : "";
  const lines = wrap(`${message.text}${thread}${reactions}${actionHint}`, bodyWidth);
  return lines.map((line, index) => (index === 0 ? `${prefix}${line}` : `${" ".repeat(visibleLength(prefix))}${line}`));
}

function commandMatches(inputText: string): SlashCommand[] {
  if (!inputText.startsWith("/")) {
    return [];
  }
  const [names] = completeSlashCommand(inputText);
  return names
    .map((name) => slashCommands.find((command) => command.name === name))
    .filter((command): command is SlashCommand => Boolean(command));
}

function replaceTrailingToken(inputText: string, value: string): string {
  const match = inputText.match(/(^|\s)(\S*)$/);
  if (!match || match.index === undefined) {
    return value;
  }
  const start = match.index + (match[1]?.length ?? 0);
  return `${inputText.slice(0, start)}${value}`;
}

function completionCandidates(store: ThaneStore, inputText: string): CompletionCandidate[] {
  if (inputText.startsWith("/join ")) {
    const prefix = inputText.slice("/join ".length).replace(/^#/, "").toLowerCase();
    return store
      .listChannels()
      .filter((channel) => channel.name.startsWith(prefix))
      .map((channel) => ({ label: `#${channel.name}`, value: `/join ${channel.name}` }));
  }
  if (inputText.startsWith("/workspace ")) {
    const prefix = inputText.slice("/workspace ".length).toLowerCase();
    return store
      .listWorkspaces()
      .filter((workspace) => workspace.slug.startsWith(prefix))
      .map((workspace) => ({ label: workspace.slug, value: `/workspace ${workspace.slug}` }));
  }
  if (inputText.startsWith("/dm ")) {
    const prefix = inputText.slice("/dm ".length).replace(/^@/, "").toLowerCase();
    return store
      .listUsers()
      .filter((user) => user.handle.startsWith(prefix) && user.id !== store.currentUser.id)
      .map((user) => ({ label: `@${user.handle}`, value: `/dm ${user.handle}` }));
  }
  const trailingMention = inputText.match(/(^|\s)@([a-z0-9._-]*)$/i);
  if (trailingMention) {
    const prefix = trailingMention[2]?.toLowerCase() ?? "";
    return store
      .listUsers()
      .filter((user) => user.handle.startsWith(prefix))
      .map((user) => ({ label: `@${user.handle}`, value: replaceTrailingToken(inputText, `@${user.handle}`) }));
  }
  return commandMatches(inputText).map((command) => ({
    label: command.usage,
    value: commandInput(command)
  }));
}

function updateMenuDescription(updateStatus: UpdateStatus): { description: string; dim: boolean } {
  if (updateStatus.state === "available") {
    return { description: `Update available: ${updateStatus.latestVersion}`, dim: false };
  }
  if (updateStatus.state === "latest") {
    return { description: `Up to date (${updateStatus.currentVersion})`, dim: true };
  }
  if (updateStatus.state === "ahead") {
    return { description: `Dev build (${updateStatus.currentVersion})`, dim: true };
  }
  if (updateStatus.state === "unavailable") {
    return { description: "Check for CLI updates", dim: false };
  }
  return { description: "Checking for updates...", dim: true };
}

function renderMenuLines(selectedIndex: number, availableRows: number, updateStatus: UpdateStatus): string[] {
  const visibleRows = Math.max(1, availableRows - 4);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), slashCommands.length - visibleRows));
  const visibleCommands = slashCommands.slice(start, start + visibleRows);
  return [
    `${BOLD}Command Menu${RESET}`,
    `${DIM}Use arrows, Return to choose, Esc to close.${RESET}`,
    "",
    ...visibleCommands.map((command, index) => {
      const actualIndex = start + index;
      const pointer = actualIndex === selectedIndex ? "> " : "  ";
      const update = command.name === "/update" ? updateMenuDescription(updateStatus) : undefined;
      const row = `${pointer}${command.usage.padEnd(26)} ${update?.description ?? command.description}`;
      if (actualIndex === selectedIndex) {
        return `${INVERSE}${row}${RESET}`;
      }
      return update?.dim ? `${DIM}${row}${RESET}` : row;
    })
  ];
}

function renderWorkspacePickerLines(store: ThaneStore, selectedIndex: number): string[] {
  const workspaces = store.listWorkspaces();
  return [
    `${BOLD}Workspaces${RESET}`,
    `${DIM}Use arrows, Return to switch, Esc to close.${RESET}`,
    "",
    ...workspaces.map((workspace, index) => {
      const active = workspace.id === store.activeWorkspace.id ? "*" : " ";
      const row = `${active} ${workspace.slug} - ${workspace.name}`;
      return index === selectedIndex ? `${INVERSE}${row}${RESET}` : row;
    })
  ];
}

function renderReactionPickerLines(selectedIndex: number): string[] {
  const options = QUICK_REACTIONS.map((reaction, index) => {
    const label = ` ${index + 1} ${reaction} `;
    return index === selectedIndex ? `${INVERSE}${label}${RESET}` : label;
  });
  return [
    `${BOLD}React${RESET}`,
    `${DIM}Use arrows or 1-${QUICK_REACTIONS.length}, Enter to apply, c for custom, Esc to close.${RESET}`,
    "",
    options.join("  ")
  ];
}

function commandInput(command: SlashCommand): string {
  return command.needsArgument ? `${command.name} ` : command.name;
}

function thaneApiBaseUrl(): string | undefined {
  const value = process.env.THANE_API_BASE_URL?.trim();
  if (value === "local" || value === "none") {
    return undefined;
  }
  return (value || "https://api.askthane.com").replace(/\/+$/g, "");
}

async function postThaneApiWithAuth<T>(path: string, authToken: string, body: Record<string, unknown> = {}): Promise<T> {
  const baseUrl = thaneApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Set THANE_API_BASE_URL to use hosted Thane Chat invite links.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `Thane API request failed with status ${response.status}`);
  }
  return payload;
}

async function getThaneApiWithAuth<T>(path: string, authToken: string): Promise<T> {
  const baseUrl = thaneApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Set THANE_API_BASE_URL to use hosted Thane Chat.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${authToken}`
    }
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `Thane API request failed with status ${response.status}`);
  }
  return payload;
}

function requireHostedAuthToken(store: ThaneStore): string {
  const token = store.currentAccount?.authToken;
  if (!token) {
    throw new Error("Run `thane init` with hosted Thane Chat auth before creating invite links.");
  }
  return token;
}

async function createWorkspaceInviteLink(store: ThaneStore, role: "admin" | "member" = "member", inviteeEmail?: string): Promise<string> {
  store.requireWorkspaceAdmin();
  const token = requireHostedAuthToken(store);
  const response = await postThaneApiWithAuth<{
    invite: {
      url: string;
      webUrl?: string;
      role: "admin" | "member";
      expiresAt: string;
      inviteeEmail?: string;
      emailSent?: boolean;
    };
  }>("/v1/thane-cli/workspace-invites", token, {
    workspaceId: store.activeWorkspace.id,
    workspaceSlug: store.activeWorkspace.slug,
    workspaceName: store.activeWorkspace.name,
    role,
    expiresInHours: 24 * 7,
    ...(inviteeEmail ? { inviteeEmail, maxUses: 1 } : {})
  });
  if (response.invite.inviteeEmail) {
    return `${response.invite.emailSent ? "Sent" : "Created"} invite for ${response.invite.inviteeEmail} (${response.invite.role}, expires ${response.invite.expiresAt})`;
  }
  const webUrl = response.invite.webUrl ?? response.invite.url;
  return `web: ${webUrl}\ncli: ${response.invite.url} (${response.invite.role}, expires ${response.invite.expiresAt})`;
}

async function updateDisplayName(store: ThaneStore, displayName: string): Promise<string> {
  const cleaned = displayName.trim();
  if (!cleaned) {
    return "Usage: /name <display-name>";
  }
  const token = requireHostedAuthToken(store);
  const response = await postThaneApiWithAuth<{ displayName: string }>("/v1/thane-cli/profile", token, { displayName: cleaned });
  await store.setDisplayName(response.displayName);
  await syncHostedStore(store);
  return `Display name: ${response.displayName}`;
}

async function mfaStatus(store: ThaneStore): Promise<string> {
  const token = requireHostedAuthToken(store);
  const status = await getThaneApiWithAuth<{ enabled: boolean }>("/v1/thane-cli/mfa/status", token);
  return status.enabled ? "MFA enabled" : "MFA disabled";
}

async function startMfaSetup(store: ThaneStore): Promise<string> {
  const token = requireHostedAuthToken(store);
  const setup = await postThaneApiWithAuth<{ factorId: string; secret: string; otpauthUrl: string }>("/v1/thane-cli/mfa/setup/start", token);
  return `MFA setup started\nfactor: ${setup.factorId}\nsecret: ${setup.secret}\notpauth: ${setup.otpauthUrl}\nfinish: /mfa-verify ${setup.factorId} 123456`;
}

async function verifyMfaSetup(store: ThaneStore, factorId: string, code: string): Promise<string> {
  const token = requireHostedAuthToken(store);
  const verified = await postThaneApiWithAuth<{ enabled: boolean }>("/v1/thane-cli/mfa/setup/verify", token, { factorId, code });
  return verified.enabled ? "MFA enabled" : "MFA setup incomplete";
}

async function disableMfa(store: ThaneStore, code: string): Promise<string> {
  const token = requireHostedAuthToken(store);
  await postThaneApiWithAuth<{ enabled: boolean }>("/v1/thane-cli/mfa/disable", token, { code });
  return "MFA disabled";
}

function renderScreen(inputText: string, state: {
  store: ThaneStore;
  activeChannelId: string;
  status: string;
  showHelp: boolean;
  showMenu: boolean;
  menuIndex: number;
  showReactionPicker: boolean;
  sidePanelLines?: string[];
  reactionIndex: number;
  focus: ChatFocus;
  conversationIndex: number;
  messageIndex: number;
  composerMode: ComposerMode;
  updateStatus: UpdateStatus;
  targetMessageId?: string;
}): void {
  const { columns, rows } = size();
  const sidebarWidth = Math.min(32, Math.max(24, Math.floor(columns * 0.28)));
  const mainWidth = columns - sidebarWidth - 1;
  const contentRows = rows - 4;
  const active = state.store.findChannel(state.activeChannelId);
  const items = conversations(state.store, state.activeChannelId);
  const messages = threadedMessages(state.store.recent(state.activeChannelId, 200));
  const targetMessage = state.targetMessageId ? messages.find((message) => message.id === state.targetMessageId) : undefined;

  const lines: string[] = [];
  const focusLabel = state.focus === "composer" ? "typing" : state.focus === "sidebar" ? "channels" : "messages";
  lines.push(`${CLEAR}${HIDE_CURSOR}${BOLD}Thane Chat${RESET} ${DIM}${state.store.activeWorkspace.slug} / ${focusLabel}${RESET}`);
  lines.push(`${"─".repeat(columns)}`);

  const firstVisibleMessage = state.focus === "messages"
    ? Math.max(0, Math.min(state.messageIndex - Math.floor(contentRows / 2), messages.length - contentRows))
    : Math.max(0, messages.length - contentRows);
  const renderedMessages = messages
    .slice(firstVisibleMessage)
    .flatMap((message, index) => renderMessage(message, mainWidth - 2, state.focus === "messages" && firstVisibleMessage + index === state.messageIndex));
  const workspaceCrest = renderWorkspaceCrest(state.store.activeWorkspace, sidebarWidth);
  const conversationRows = Math.max(1, contentRows - workspaceCrest.length);
  const firstVisibleConversation = state.focus === "sidebar"
    ? Math.max(0, Math.min(state.conversationIndex - Math.floor(conversationRows / 2), items.length - conversationRows))
    : 0;
  const helpLines = state.showMenu
    ? renderMenuLines(state.menuIndex, contentRows, state.updateStatus)
    : state.showReactionPicker
    ? renderReactionPickerLines(state.reactionIndex)
    : state.sidePanelLines
    ? state.sidePanelLines.slice(0, contentRows)
    : state.showHelp
    ? [
        `${BOLD}Commands${RESET}`,
        "/join <channel>   /dm <handle>   /workspace <slug>",
        "/commands         /help          /quit",
        "",
        ...renderSlashCommands().split("\n").slice(0, Math.max(0, contentRows - 5))
      ]
    : renderedMessages.slice(-contentRows);

  for (let row = 0; row < contentRows; row += 1) {
    const itemIndex = firstVisibleConversation + row - workspaceCrest.length;
    const item = row >= workspaceCrest.length ? items[itemIndex] : undefined;
    let left = "";
    if (row < workspaceCrest.length) {
      left = workspaceCrest[row] ?? " ".repeat(sidebarWidth);
    } else if (item) {
      const unread = item.unreadCount > 0 ? ` ${item.unreadCount}` : "";
      const mention = item.mentionCount > 0 ? " @" : "";
      const marker = item.id === state.activeChannelId ? ">" : " ";
      left = `${marker} ${item.label}${mention}${unread}`;
      if (state.focus === "sidebar" && itemIndex === state.conversationIndex) {
        left = `${INVERSE}${fit(left, sidebarWidth)}${RESET}`;
      } else if (item.id === state.activeChannelId) {
        left = `${INVERSE}${fit(left, sidebarWidth)}${RESET}`;
      } else {
        left = fit(left, sidebarWidth);
      }
    } else {
      left = " ".repeat(sidebarWidth);
    }
    const right = fit(helpLines[row] ?? "", mainWidth - 1);
    lines.push(`${left}│${right}`);
  }

  const matches = state.showMenu || state.showReactionPicker ? [] : completionCandidates(state.store, inputText).slice(0, 4);
  const suggestionStatus = matches.length > 0
    ? `${DIM}Tab completes:${RESET} ${matches.map((candidate) => candidate.label).join("  ")}`
    : "";
  const modePrefix = state.composerMode === "reply" && targetMessage
    ? `Replying to @${targetMessage.author}. `
    : state.composerMode === "react" && targetMessage
    ? `Reacting to @${targetMessage.author}. `
    : "";
  const defaultStatus = state.focus === "sidebar"
    ? `${DIM}Up/down chooses a channel or DM. Down at the bottom types. Enter opens.${RESET}`
    : state.focus === "messages"
    ? `${DIM}Up/down chooses a message. Down at the bottom types. r replies. e reacts.${RESET}`
    : `${active ? channelLabel(active) : "conversation"}  ${DIM}Up messages. Left channels. Right messages. /menu opens menu.${RESET}`;
  const status = modePrefix || suggestionStatus || state.status || defaultStatus;
  lines.push(`${"─".repeat(columns)}`);
  lines.push(fit(status, columns));
  const prompt = state.composerMode === "reply" ? "reply> " : state.composerMode === "react" ? "react> " : "> ";
  lines.push(fit(`${prompt}${inputText}`, columns));
  output.write(lines.join("\n"));
}

export async function runChat(initialChannel = "general"): Promise<void> {
  let store = await ThaneStore.open();
  try {
    await syncHostedStore(store);
    store = await ThaneStore.open();
  } catch (_error) {
    // Stay usable offline; the footer will surface explicit command failures.
  }
  let activeChannel = await selectConversation(store, initialChannel);
  let inputText = "";
  let status = "";
  let showHelp = false;
  let showMenu = false;
  let sidePanelLines: string[] | undefined;
  let workspacePickerOpen = false;
  let workspacePickerIndex = 0;
  let menuIndex = 0;
  let showReactionPicker = false;
  let reactionIndex = 0;
  let focus: ChatFocus = "composer";
  let conversationIndex = 0;
  let messageIndex = 0;
  let composerMode: ComposerMode = "message";
  let updateStatus: UpdateStatus = { state: "checking" };
  let targetMessageId: string | undefined;
  let isOpen = true;
  let lastHostedSyncMs = 0;

  const refresh = async (): Promise<void> => {
    store = await ThaneStore.open();
    if (hasHostedChat(store) && Date.now() - lastHostedSyncMs > 2500) {
      try {
        await syncHostedStore(store, { workspaceId: store.activeWorkspace.id });
        lastHostedSyncMs = Date.now();
        store = await ThaneStore.open();
      } catch (error) {
        status ||= `Hosted sync failed: ${(error as Error).message}`;
      }
    }
    if (!store.findChannel(activeChannel.id)) {
      activeChannel = await selectConversation(store, "general");
    }
    const items = conversations(store, activeChannel.id);
    const activeIndex = items.findIndex((item) => item.id === activeChannel.id);
    if (focus !== "sidebar") {
      conversationIndex = Math.max(0, activeIndex);
    } else {
      conversationIndex = Math.min(Math.max(0, conversationIndex), Math.max(0, items.length - 1));
    }
    const messages = threadedMessages(store.recent(activeChannel.id, 200));
    messageIndex = Math.min(Math.max(0, messageIndex), Math.max(0, messages.length - 1));
    if (targetMessageId && !messages.some((message) => message.id === targetMessageId)) {
      targetMessageId = undefined;
      composerMode = "message";
    }
    renderScreen(inputText, {
      store,
      activeChannelId: activeChannel.id,
      status,
      showHelp,
      showMenu,
      ...(sidePanelLines ? { sidePanelLines } : {}),
      menuIndex,
      showReactionPicker,
      reactionIndex,
      focus,
      conversationIndex,
      messageIndex,
      composerMode,
      updateStatus,
      ...(targetMessageId ? { targetMessageId } : {})
    });
  };

  const refreshUpdateStatus = async (force = false): Promise<UpdateStatus> => {
    updateStatus = await checkForUpdate({ force });
    await refresh();
    return updateStatus;
  };

  const switchTo = async (conversationId: string, nextFocus: ChatFocus = "messages"): Promise<void> => {
    const channel = store.findChannel(conversationId);
    if (!channel) {
      return;
    }
    activeChannel = channel;
    showHelp = false;
    showMenu = false;
    sidePanelLines = undefined;
    workspacePickerOpen = false;
    showReactionPicker = false;
    focus = nextFocus;
    messageIndex = Math.max(0, threadedMessages(store.recent(activeChannel.id, 200)).length - 1);
    status = `Switched to ${channelLabel(channel)}`;
    await store.markReadConversation(activeChannel.id);
    await refresh();
  };

  const switchConversation = async (direction: 1 | -1): Promise<void> => {
    const items = conversations(store, activeChannel.id);
    const index = Math.max(0, items.findIndex((item) => item.id === activeChannel.id));
    const next = items[(index + direction + items.length) % items.length];
    if (next) {
      await switchTo(next.id);
    }
  };

  const focusSidebar = (): void => {
    const items = conversations(store, activeChannel.id);
    conversationIndex = Math.max(0, items.findIndex((item) => item.id === activeChannel.id));
    focus = "sidebar";
    status = "";
  };

  const focusMessages = (): void => {
    const messages = threadedMessages(store.recent(activeChannel.id, 200));
    messageIndex = Math.max(0, messages.length - 1);
    focus = "messages";
    status = "";
  };

  const focusComposer = (): void => {
    focus = "composer";
    status = "";
  };

  const selectedMessage = (): MessageView | undefined => {
    return threadedMessages(store.recent(activeChannel.id, 200))[messageIndex];
  };

  const startReply = (): void => {
    const message = selectedMessage();
    if (!message) {
      status = "No message selected.";
      return;
    }
    targetMessageId = message.id;
    composerMode = "reply";
    inputText = "";
    focus = "composer";
    status = `Replying to @${message.author}`;
  };

  const startReact = (): void => {
    const message = selectedMessage();
    if (!message) {
      status = "No message selected.";
      return;
    }
    targetMessageId = message.id;
    composerMode = "react";
    inputText = "";
    showReactionPicker = true;
    status = `Reacting to @${message.author}`;
  };

  const applyReaction = async (emoji: string): Promise<void> => {
    if (!targetMessageId) {
      composerMode = "message";
      showReactionPicker = false;
      status = "No reaction target selected.";
      return;
    }
    requireHostedAuthToken(store);
    await reactHostedMessage(store, { messageId: targetMessageId, emoji });
    store = await ThaneStore.open();
    composerMode = "message";
    targetMessageId = undefined;
    showReactionPicker = false;
    focus = "messages";
    status = `Reacted ${emoji}`;
  };

  const runLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "/quit" || trimmed === "/exit") {
      isOpen = false;
      return;
    }
    if (composerMode === "reply") {
      if (!targetMessageId) {
        composerMode = "message";
        status = "No reply target selected.";
        return;
      }
      const root = selectedMessage();
      const threadRootId = root?.threadRootId ?? root?.id ?? targetMessageId;
      requireHostedAuthToken(store);
      await sendHostedMessage(store, { channelId: activeChannel.id, text: trimmed, source: "chat", threadRootId });
      store = await ThaneStore.open();
      const sent = threadedMessages(store.recent(activeChannel.id, 200)).at(-1);
      composerMode = "message";
      targetMessageId = undefined;
      messageIndex = Math.max(0, threadedMessages(store.recent(activeChannel.id, 200)).findIndex((message) => message.id === sent?.id));
      status = "";
      await store.markReadConversation(activeChannel.id);
      return;
    }
    if (composerMode === "react") {
      await applyReaction(trimmed);
      return;
    }
    if (trimmed === "/menu") {
      showMenu = true;
      showHelp = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      status = "Command menu";
      return;
    }
    if (trimmed === "/update") {
      updateStatus = { state: "checking" };
      status = "Checking for updates...";
      await refreshUpdateStatus(true);
      status = renderUpdateStatus(updateStatus).replace(/\n/g, " ");
      return;
    }
    if (trimmed === "/mfa") {
      status = await mfaStatus(store);
      return;
    }
    if (trimmed === "/mfa-setup") {
      sidePanelLines = [`${BOLD}MFA Setup${RESET}`, "", ...(await startMfaSetup(store)).split("\n")];
      showHelp = false;
      showMenu = false;
      workspacePickerOpen = false;
      showReactionPicker = false;
      status = "Add the secret to your authenticator app.";
      return;
    }
    if (trimmed.startsWith("/mfa-verify ")) {
      const match = trimmed.match(/^\/mfa-verify\s+(\S+)\s+(\d{6})$/);
      if (!match?.[1] || !match[2]) {
        status = "Usage: /mfa-verify <factor-id> <code>";
        return;
      }
      status = await verifyMfaSetup(store, match[1], match[2]);
      sidePanelLines = undefined;
      return;
    }
    if (trimmed.startsWith("/mfa-disable ")) {
      const code = trimmed.slice("/mfa-disable ".length).trim();
      if (!/^\d{6}$/.test(code)) {
        status = "Usage: /mfa-disable <code>";
        return;
      }
      status = await disableMfa(store, code);
      return;
    }
    if (trimmed === "/workspace-art") {
      const current = store.activeWorkspace.asciiArt?.trim();
      status = current
        ? "Custom workspace art is set. Use `thane workspace art show|set|reset` to manage it."
        : "Using generated workspace art. Admins can set custom art with `thane workspace art set --file art.txt` or `--stdin`.";
      return;
    }
    if (trimmed === "/workspace-art reset") {
      await store.clearWorkspaceAsciiArt();
      status = "Reset workspace art to generated default.";
      return;
    }
    if (trimmed.startsWith("/name ")) {
      status = await updateDisplayName(store, trimmed.slice("/name ".length));
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed.startsWith("/invite ")) {
      const email = trimmed.slice("/invite ".length).trim();
      if (!email) {
        status = "Usage: /invite <email>";
        return;
      }
      status = await createWorkspaceInviteLink(store, "member", email);
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed === "/invite-link" || trimmed === "/invite-link create" || trimmed === "/invite-link admin") {
      const role = trimmed.endsWith(" admin") ? "admin" : "member";
      status = `Invite link: ${await createWorkspaceInviteLink(store, role)}`;
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed === "/help" || trimmed === "/commands") {
      showHelp = !showHelp;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      status = showHelp ? "Command help" : "";
      return;
    }
    if (trimmed === "/workspaces") {
      const workspaces = store.listWorkspaces();
      workspacePickerIndex = Math.max(0, workspaces.findIndex((workspace) => workspace.id === store.activeWorkspace.id));
      sidePanelLines = renderWorkspacePickerLines(store, workspacePickerIndex);
      workspacePickerOpen = true;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Active workspace: ${store.activeWorkspace.slug}`;
      return;
    }
    if (trimmed === "/channels") {
      sidePanelLines = [`${BOLD}Channels${RESET}`, "", ...renderChannels(store.listChannels()).split("\n")];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = "Channels in this workspace.";
      return;
    }
    if (trimmed === "/members") {
      const members = activeChannel.kind === "channel" ? store.channelMembers(activeChannel.name) : store.listUsers();
      sidePanelLines = [`${BOLD}Members: ${channelLabel(activeChannel)}${RESET}`, "", ...renderUsers(members).split("\n")];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Members in ${channelLabel(activeChannel)}.`;
      return;
    }
    if (trimmed === "/inbox" || trimmed === "/inbox all") {
      const allWorkspaces = trimmed.endsWith(" all");
      sidePanelLines = [
        `${BOLD}${allWorkspaces ? "Inbox: All Workspaces" : "Inbox"}${RESET}`,
        "",
        ...renderInbox(store.inbox({ allWorkspaces })).split("\n")
      ];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = allWorkspaces ? "Unread conversations across workspaces." : "Unread conversations in this workspace.";
      return;
    }
    if (trimmed === "/recent") {
      sidePanelLines = [
        `${BOLD}Recent: ${channelLabel(activeChannel)}${RESET}`,
        "",
        ...renderMessages(store.recent(activeChannel.id, 12)).split("\n")
      ];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Recent messages in ${channelLabel(activeChannel)}.`;
      return;
    }
    if (trimmed.startsWith("/thread ")) {
      const messageId = trimmed.slice("/thread ".length).trim();
      sidePanelLines = [`${BOLD}Thread${RESET}`, "", ...renderMessages(store.thread(messageId)).split("\n")];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Thread ${messageId}`;
      return;
    }
    if (trimmed.startsWith("/reply ")) {
      const match = trimmed.match(/^\/reply\s+(\S+)\s+([\s\S]+)$/);
      if (!match?.[1] || !match[2]?.trim()) {
        status = "Usage: /reply <message-id> <text>";
        return;
      }
      const messageId = match[1];
      const text = match[2].trim();
      const root = store.thread(messageId)[0];
      if (!root) {
        status = `Message ${messageId} was not found.`;
        return;
      }
      const target = store.findChannel(root.channel);
      if (!target) {
        status = `Channel ${root.channel} was not found.`;
        return;
      }
      requireHostedAuthToken(store);
      await sendHostedMessage(store, { channelId: target.id, text, source: "chat", threadRootId: root.threadRootId ?? root.id });
      store = await ThaneStore.open();
      activeChannel = target;
      sidePanelLines = [`${BOLD}Thread${RESET}`, "", ...renderMessages(store.thread(messageId)).split("\n")];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Replied in thread ${messageId}.`;
      return;
    }
    if (trimmed.startsWith("/react ")) {
      const match = trimmed.match(/^\/react\s+(\S+)\s+(.+)$/);
      if (!match?.[1] || !match[2]?.trim()) {
        status = "Usage: /react <message-id> <emoji>";
        return;
      }
      const messageId = match[1];
      const emoji = match[2].trim();
      requireHostedAuthToken(store);
      await reactHostedMessage(store, { messageId, emoji });
      store = await ThaneStore.open();
      status = `Reacted ${emoji}`;
      return;
    }
    if (trimmed.startsWith("/search ")) {
      const query = trimmed.slice("/search ".length).trim();
      if (!query) {
        status = "Usage: /search <query>";
        return;
      }
      sidePanelLines = [`${BOLD}Search: ${query}${RESET}`, "", ...renderMessages(store.search(query, 20)).split("\n")];
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Search results for ${query}.`;
      return;
    }
    if (trimmed === "/leave") {
      if (activeChannel.kind === "dm") {
        status = "DMs cannot be left.";
        return;
      }
      const left = await store.leaveChannel(activeChannel.name);
      activeChannel = await selectConversation(store, "general");
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      status = `Left #${left.name}`;
      return;
    }
    if (trimmed.startsWith("/join ")) {
      const channelName = trimmed.slice("/join ".length).trim();
      if (hasHostedChat(store)) {
        await createHostedChannel(store, { name: channelName });
        store = await ThaneStore.open();
      }
      activeChannel = await selectConversation(store, channelName);
      await store.markReadConversation(activeChannel.id);
      status = `Joined ${channelLabel(activeChannel)}`;
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      focus = "messages";
      messageIndex = Math.max(0, threadedMessages(store.recent(activeChannel.id, 200)).length - 1);
      return;
    }
    if (trimmed.startsWith("/dm ")) {
      activeChannel = await selectConversation(store, `@${trimmed.slice("/dm ".length).trim()}`);
      await store.markReadConversation(activeChannel.id);
      status = `Opened ${channelLabel(activeChannel)}`;
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      focus = "messages";
      messageIndex = Math.max(0, threadedMessages(store.recent(activeChannel.id, 200)).length - 1);
      return;
    }
    if (trimmed.startsWith("/workspace ")) {
      const workspace = await store.useWorkspace(trimmed.slice("/workspace ".length).trim());
      if (hasHostedChat(store)) {
        await syncHostedStore(store, { workspaceId: workspace.id });
        store = await ThaneStore.open();
      }
      activeChannel = await selectConversation(store, "general");
      status = `Switched to workspace ${workspace.slug}`;
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed.startsWith("/workspace-create ")) {
      const parts = trimmed.slice("/workspace-create ".length).trim().split(/\s+/).filter(Boolean);
      const slug = parts.shift();
      const name = parts.join(" ");
      if (!slug) {
        status = "Usage: /workspace-create <slug> [name]";
        return;
      }
      requireHostedAuthToken(store);
      await createHostedWorkspace(store, {
        workspaceId: hostedWorkspaceId(),
        slug,
        ...(name ? { name } : {})
      });
      store = await ThaneStore.open();
      const workspace = store.activeWorkspace;
      activeChannel = await selectConversation(store, "general");
      status = `Created workspace ${workspace.slug}`;
      showHelp = false;
      showMenu = false;
      sidePanelLines = undefined;
      workspacePickerOpen = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed.startsWith("/")) {
      status = "Unknown command. Type /help.";
      return;
    }
    requireHostedAuthToken(store);
    await sendHostedMessage(store, { channelId: activeChannel.id, text: trimmed, source: "chat" });
    store = await ThaneStore.open();
    const sent = threadedMessages(store.recent(activeChannel.id, 200)).at(-1);
    const messages = threadedMessages(store.recent(activeChannel.id, 200));
    status = sent && messages.some((message) => message.id === sent.id) ? "" : "";
    messageIndex = Math.max(0, sent ? messages.findIndex((message) => message.id === sent.id) : messages.length - 1);
    showHelp = false;
    showMenu = false;
    sidePanelLines = undefined;
    workspacePickerOpen = false;
    await store.markReadConversation(activeChannel.id);
  };

  const completeInput = (): boolean => {
    const matches = completionCandidates(store, inputText);
    if (matches.length === 0) {
      return false;
    }
    if (matches.length === 1) {
      const match = matches[0];
      if (!match) {
        return false;
      }
      inputText = match.value;
      return true;
    }
    const values = matches.map((candidate) => candidate.value);
    let prefix = values[0] ?? inputText;
    for (const value of values.slice(1)) {
      while (!value.startsWith(prefix) && prefix.length > 1) {
        prefix = prefix.slice(0, -1);
      }
    }
    if (prefix.length > inputText.length) {
      inputText = prefix;
    } else {
      const firstCommand = commandMatches(inputText)[0];
      if (firstCommand) {
        menuIndex = Math.max(0, slashCommands.findIndex((command) => command.name === firstCommand.name));
        showMenu = true;
        showHelp = false;
        sidePanelLines = undefined;
        workspacePickerOpen = false;
        status = "Command menu";
      } else {
        status = `Matches: ${matches.slice(0, 4).map((candidate) => candidate.label).join("  ")}`;
      }
    }
    return true;
  };

  emitKeypressEvents(input);
  if (input.isTTY) {
    input.setRawMode?.(true);
  }
  input.resume();
  void refreshUpdateStatus();

  const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): void => {
    void (async () => {
      try {
        if ((key.ctrl && key.name === "c") || key.sequence === "\u0003") {
          isOpen = false;
          return;
        }
        if (showMenu) {
          if (key.name === "escape") {
            showMenu = false;
            status = "";
          } else if (key.name === "up") {
            menuIndex = menuIndex === 0 ? slashCommands.length - 1 : menuIndex - 1;
          } else if (key.name === "down" || key.name === "tab") {
            menuIndex = menuIndex === slashCommands.length - 1 ? 0 : menuIndex + 1;
          } else if (key.name === "return") {
            const selected = slashCommands[menuIndex];
            if (!selected) {
              showMenu = false;
              status = "";
              await refresh();
              return;
            }
            showMenu = false;
            if (selected.needsArgument) {
              inputText = commandInput(selected);
              status = `${selected.usage} ${DIM}${selected.description}${RESET}`;
            } else {
              inputText = "";
              await runLine(selected.name);
            }
          }
          if (!isOpen) {
            return;
          }
          await refresh();
          return;
        }
        if (showReactionPicker) {
          if (key.name === "escape") {
            showReactionPicker = false;
            composerMode = "message";
            targetMessageId = undefined;
            status = "";
          } else if (key.name === "left" || key.name === "up") {
            reactionIndex = reactionIndex === 0 ? QUICK_REACTIONS.length - 1 : reactionIndex - 1;
          } else if (key.name === "right" || key.name === "down" || key.name === "tab") {
            reactionIndex = reactionIndex === QUICK_REACTIONS.length - 1 ? 0 : reactionIndex + 1;
          } else if (key.name === "return") {
            await applyReaction(QUICK_REACTIONS[reactionIndex] ?? "👍");
          } else if (/^[1-8]$/.test(key.sequence ?? "")) {
            const selectedIndex = Number(key.sequence) - 1;
            await applyReaction(QUICK_REACTIONS[selectedIndex] ?? "👍");
          } else if (key.name === "c") {
            showReactionPicker = false;
            focus = "composer";
            inputText = "";
            status = "Type a custom reaction, then Enter.";
          } else if (key.sequence && key.sequence >= " " && !key.ctrl) {
            showReactionPicker = false;
            focus = "composer";
            inputText = key.sequence;
            status = "Type a custom reaction, then Enter.";
          }
          if (!isOpen) {
            return;
          }
          await refresh();
          return;
        }
        if (workspacePickerOpen) {
          const workspaces = store.listWorkspaces();
          if (key.name === "escape") {
            workspacePickerOpen = false;
            sidePanelLines = undefined;
            status = "";
          } else if (key.name === "up") {
            workspacePickerIndex = workspacePickerIndex === 0 ? Math.max(0, workspaces.length - 1) : workspacePickerIndex - 1;
            sidePanelLines = renderWorkspacePickerLines(store, workspacePickerIndex);
          } else if (key.name === "down" || key.name === "tab") {
            workspacePickerIndex = workspacePickerIndex >= workspaces.length - 1 ? 0 : workspacePickerIndex + 1;
            sidePanelLines = renderWorkspacePickerLines(store, workspacePickerIndex);
          } else if (key.name === "return") {
            const selected = workspaces[workspacePickerIndex];
            if (selected) {
              const workspace = await store.useWorkspace(selected.slug);
              if (hasHostedChat(store)) {
                await syncHostedStore(store, { workspaceId: workspace.id });
                store = await ThaneStore.open();
              }
              activeChannel = await selectConversation(store, "general");
              workspacePickerOpen = false;
              sidePanelLines = undefined;
              status = `Switched to workspace ${workspace.slug}`;
            }
          } else if (key.sequence && key.sequence >= " " && !key.ctrl) {
            workspacePickerOpen = false;
            sidePanelLines = undefined;
            inputText = key.sequence;
            focusComposer();
          }
          if (!isOpen) {
            return;
          }
          await refresh();
          return;
        }
        if (focus === "sidebar") {
          const items = conversations(store, activeChannel.id);
          if (key.name === "up") {
            conversationIndex = Math.max(0, conversationIndex - 1);
          } else if (key.name === "down") {
            if (conversationIndex >= items.length - 1) {
              focusComposer();
            } else {
              conversationIndex += 1;
            }
          } else if (key.name === "return") {
            const selected = items[conversationIndex];
            if (selected) {
              await switchTo(selected.id, "sidebar");
              return;
            }
          } else if (key.name === "right") {
            focusMessages();
          } else if (key.name === "left") {
            focusComposer();
          } else if (key.name === "escape") {
            focusComposer();
          } else if (key.sequence && key.sequence >= " " && !key.ctrl) {
            inputText = key.sequence;
            focusComposer();
          }
          await refresh();
          return;
        }
        if (focus === "messages") {
          const messages = threadedMessages(store.recent(activeChannel.id, 200));
          if (key.name === "up") {
            messageIndex = Math.max(0, messageIndex - 1);
          } else if (key.name === "down") {
            if (messageIndex >= messages.length - 1) {
              focusComposer();
            } else {
              messageIndex += 1;
            }
          } else if (key.name === "return" || key.name === "r") {
            startReply();
          } else if (key.name === "e" || key.name === "+") {
            startReact();
          } else if (key.name === "left") {
            focusSidebar();
          } else if (key.name === "right") {
            focusComposer();
          } else if (key.name === "escape") {
            focusComposer();
          } else if (key.sequence && key.sequence >= " " && !key.ctrl) {
            inputText = key.sequence;
            focusComposer();
          }
          await refresh();
          return;
        }
        if (key.name === "return") {
          const submitted = inputText;
          inputText = "";
          await runLine(submitted);
        } else if (key.name === "backspace") {
          inputText = inputText.slice(0, -1);
        } else if (key.name === "up") {
          if (key.ctrl || key.meta || key.sequence === "\u001b[1;5A" || key.sequence === "\u001b[1;3A") {
            await switchConversation(-1);
            return;
          }
          focusMessages();
        } else if (key.name === "down") {
          if (key.ctrl || key.meta || key.sequence === "\u001b[1;5B" || key.sequence === "\u001b[1;3B") {
            await switchConversation(1);
            return;
          }
        } else if (key.name === "tab") {
          if (completeInput()) {
            await refresh();
            return;
          }
        } else if (key.name === "left") {
          focusSidebar();
        } else if (key.name === "right") {
          focusMessages();
        } else if (key.name === "escape") {
          showHelp = false;
          showMenu = false;
          sidePanelLines = undefined;
          workspacePickerOpen = false;
          showReactionPicker = false;
          if (composerMode !== "message") {
            composerMode = "message";
            targetMessageId = undefined;
            inputText = "";
          }
          status = "";
        } else if (key.sequence && key.sequence >= " " && !key.ctrl) {
          inputText += key.sequence;
        }
        if (!isOpen) {
          return;
        }
        await refresh();
      } catch (error) {
        status = (error as Error).message;
        await refresh();
      }
    })();
  };

  input.on("keypress", onKeypress);
  const poll = setInterval(() => {
    if (isOpen) {
      void refresh();
    }
  }, 1_500);

  try {
    await store.markReadConversation(activeChannel.id);
    await refresh();
    while (isOpen) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    clearInterval(poll);
    input.off("keypress", onKeypress);
    if (input.isTTY) {
      input.setRawMode?.(false);
    }
    output.write(`${SHOW_CURSOR}${RESET}\x1b[2J\x1b[H`);
  }
}
