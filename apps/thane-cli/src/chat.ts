import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { completeSlashCommand, renderSlashCommands, slashCommands } from "./slash-commands.js";
import { ThaneStore } from "./store.js";
import type { ConversationSummary, MessageView, ThaneChannel } from "./model.js";
import type { SlashCommand } from "./slash-commands.js";

const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const INVERSE = "\x1b[7m";
const BOLD = "\x1b[1m";

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
    return store.findOrCreateDm(target.slice(1));
  }
  return store.createChannel(target.replace(/^#/, ""));
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

function renderMenuLines(selectedIndex: number, availableRows: number): string[] {
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
      const row = `${pointer}${command.usage.padEnd(26)} ${command.description}`;
      return actualIndex === selectedIndex ? `${INVERSE}${row}${RESET}` : row;
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

function requireHostedAuthToken(store: ThaneStore): string {
  const token = store.currentAccount?.authToken;
  if (!token) {
    throw new Error("Run `thane init` with hosted Thane Chat auth before creating invite links.");
  }
  return token;
}

async function createWorkspaceInviteLink(store: ThaneStore, role: "admin" | "member" = "member"): Promise<string> {
  store.requireWorkspaceAdmin();
  const token = requireHostedAuthToken(store);
  const response = await postThaneApiWithAuth<{
    invite: {
      url: string;
      role: "admin" | "member";
      expiresAt: string;
    };
  }>("/v1/thane-cli/workspace-invites", token, {
    workspaceId: store.activeWorkspace.id,
    workspaceSlug: store.activeWorkspace.slug,
    workspaceName: store.activeWorkspace.name,
    role,
    expiresInHours: 24 * 7
  });
  return `${response.invite.url} (${response.invite.role}, expires ${response.invite.expiresAt})`;
}

function renderScreen(inputText: string, state: {
  store: ThaneStore;
  activeChannelId: string;
  status: string;
  showHelp: boolean;
  showMenu: boolean;
  menuIndex: number;
  showReactionPicker: boolean;
  reactionIndex: number;
  focus: ChatFocus;
  conversationIndex: number;
  messageIndex: number;
  composerMode: ComposerMode;
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
  const firstVisibleConversation = state.focus === "sidebar"
    ? Math.max(0, Math.min(state.conversationIndex - Math.floor(contentRows / 2), items.length - contentRows))
    : 0;
  const helpLines = state.showMenu
    ? renderMenuLines(state.menuIndex, contentRows)
    : state.showReactionPicker
    ? renderReactionPickerLines(state.reactionIndex)
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
    const itemIndex = firstVisibleConversation + row;
    const item = items[itemIndex];
    let left = "";
    if (item) {
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
  let activeChannel = await selectConversation(store, initialChannel);
  let inputText = "";
  let status = "";
  let showHelp = false;
  let showMenu = false;
  let menuIndex = 0;
  let showReactionPicker = false;
  let reactionIndex = 0;
  let focus: ChatFocus = "composer";
  let conversationIndex = 0;
  let messageIndex = 0;
  let composerMode: ComposerMode = "message";
  let targetMessageId: string | undefined;
  let isOpen = true;

  const refresh = async (): Promise<void> => {
    store = await ThaneStore.open();
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
      menuIndex,
      showReactionPicker,
      reactionIndex,
      focus,
      conversationIndex,
      messageIndex,
      composerMode,
      ...(targetMessageId ? { targetMessageId } : {})
    });
  };

  const switchTo = async (conversationId: string, nextFocus: ChatFocus = "messages"): Promise<void> => {
    const channel = store.findChannel(conversationId);
    if (!channel) {
      return;
    }
    activeChannel = channel;
    showHelp = false;
    showMenu = false;
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
    await store.react(targetMessageId, emoji);
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
      const sent = await store.reply(targetMessageId, trimmed, "chat");
      composerMode = "message";
      targetMessageId = undefined;
      messageIndex = Math.max(0, threadedMessages(store.recent(activeChannel.id, 200)).findIndex((message) => message.id === sent.id));
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
      status = "Command menu";
      return;
    }
    if (trimmed === "/invite-link" || trimmed === "/invite-link create" || trimmed === "/invite-link admin") {
      const role = trimmed.endsWith(" admin") ? "admin" : "member";
      status = `Invite link: ${await createWorkspaceInviteLink(store, role)}`;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed === "/help" || trimmed === "/commands") {
      showHelp = !showHelp;
      showMenu = false;
      status = showHelp ? "Command help" : "";
      return;
    }
    if (trimmed.startsWith("/join ")) {
      activeChannel = await selectConversation(store, trimmed.slice("/join ".length).trim());
      await store.markReadConversation(activeChannel.id);
      status = `Joined ${channelLabel(activeChannel)}`;
      showHelp = false;
      showMenu = false;
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
      showReactionPicker = false;
      focus = "messages";
      messageIndex = Math.max(0, threadedMessages(store.recent(activeChannel.id, 200)).length - 1);
      return;
    }
    if (trimmed.startsWith("/workspace ")) {
      const workspace = await store.useWorkspace(trimmed.slice("/workspace ".length).trim());
      activeChannel = await selectConversation(store, "general");
      status = `Switched to workspace ${workspace.slug}`;
      showHelp = false;
      showMenu = false;
      showReactionPicker = false;
      return;
    }
    if (trimmed.startsWith("/")) {
      status = "Unknown command. Type /help.";
      return;
    }
    const sent = await store.sendMessage(activeChannel.id, trimmed, undefined, "chat");
    const messages = threadedMessages(store.recent(activeChannel.id, 200));
    status = messages.some((message) => message.id === sent.id) ? "" : "";
    messageIndex = Math.max(0, messages.findIndex((message) => message.id === sent.id));
    showHelp = false;
    showMenu = false;
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
