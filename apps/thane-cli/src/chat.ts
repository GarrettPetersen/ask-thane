import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { renderSlashCommands } from "./slash-commands.js";
import { ThaneStore } from "./store.js";
import type { ConversationSummary, MessageView, ThaneChannel } from "./model.js";

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

function renderMessage(message: MessageView, width: number): string[] {
  const date = new Date(message.createdAt);
  const time = Number.isNaN(date.getTime())
    ? message.createdAt
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const prefix = `${DIM}${time}${RESET} ${BOLD}${message.author}${RESET}: `;
  const bodyWidth = Math.max(10, width - visibleLength(prefix));
  const lines = wrap(message.text, bodyWidth);
  return lines.map((line, index) => (index === 0 ? `${prefix}${line}` : `${" ".repeat(visibleLength(prefix))}${line}`));
}

function renderScreen(inputText: string, state: {
  store: ThaneStore;
  activeChannelId: string;
  status: string;
  showHelp: boolean;
}): void {
  const { columns, rows } = size();
  const sidebarWidth = Math.min(32, Math.max(24, Math.floor(columns * 0.28)));
  const mainWidth = columns - sidebarWidth - 1;
  const contentRows = rows - 4;
  const active = state.store.findChannel(state.activeChannelId);
  const items = conversations(state.store, state.activeChannelId);
  const messages = state.store.recent(state.activeChannelId, 200);

  const lines: string[] = [];
  lines.push(`${CLEAR}${HIDE_CURSOR}${BOLD}Thane Chat${RESET} ${DIM}${state.store.activeWorkspace.slug}${RESET}`);
  lines.push(`${"─".repeat(columns)}`);

  const renderedMessages = messages.flatMap((message) => renderMessage(message, mainWidth - 2));
  const helpLines = state.showHelp
    ? [
        `${BOLD}Commands${RESET}`,
        "/join <channel>   /dm <handle>   /workspace <slug>",
        "/commands         /help          /quit",
        "",
        ...renderSlashCommands().split("\n").slice(0, Math.max(0, contentRows - 5))
      ]
    : renderedMessages.slice(-contentRows);

  for (let row = 0; row < contentRows; row += 1) {
    const item = items[row];
    let left = "";
    if (item) {
      const unread = item.unreadCount > 0 ? ` ${item.unreadCount}` : "";
      const mention = item.mentionCount > 0 ? " @" : "";
      const marker = item.id === state.activeChannelId ? ">" : " ";
      left = `${marker} ${item.label}${mention}${unread}`;
      if (item.id === state.activeChannelId) {
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

  const status = state.status || `${active ? channelLabel(active) : "conversation"}  ${DIM}Enter sends. Up/down switches. /help for commands.${RESET}`;
  lines.push(`${"─".repeat(columns)}`);
  lines.push(fit(status, columns));
  lines.push(fit(`> ${inputText}`, columns));
  output.write(lines.join("\n"));
}

export async function runChat(initialChannel = "general"): Promise<void> {
  let store = await ThaneStore.open();
  let activeChannel = await selectConversation(store, initialChannel);
  let inputText = "";
  let status = "";
  let showHelp = false;
  let isOpen = true;

  const refresh = async (): Promise<void> => {
    store = await ThaneStore.open();
    renderScreen(inputText, { store, activeChannelId: activeChannel.id, status, showHelp });
  };

  const switchTo = async (conversationId: string): Promise<void> => {
    const channel = store.findChannel(conversationId);
    if (!channel) {
      return;
    }
    activeChannel = channel;
    showHelp = false;
    status = `Switched to ${channelLabel(channel)}`;
    await store.markReadConversation(activeChannel.id);
    await refresh();
  };

  const moveSelection = async (direction: 1 | -1): Promise<void> => {
    const items = conversations(store, activeChannel.id);
    const index = Math.max(0, items.findIndex((item) => item.id === activeChannel.id));
    const next = items[(index + direction + items.length) % items.length];
    if (next) {
      await switchTo(next.id);
    }
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
    if (trimmed === "/help" || trimmed === "/commands" || trimmed === "/menu") {
      showHelp = !showHelp;
      status = showHelp ? "Command help" : "";
      return;
    }
    if (trimmed.startsWith("/join ")) {
      activeChannel = await selectConversation(store, trimmed.slice("/join ".length).trim());
      await store.markReadConversation(activeChannel.id);
      status = `Joined ${channelLabel(activeChannel)}`;
      showHelp = false;
      return;
    }
    if (trimmed.startsWith("/dm ")) {
      activeChannel = await selectConversation(store, `@${trimmed.slice("/dm ".length).trim()}`);
      await store.markReadConversation(activeChannel.id);
      status = `Opened ${channelLabel(activeChannel)}`;
      showHelp = false;
      return;
    }
    if (trimmed.startsWith("/workspace ")) {
      const workspace = await store.useWorkspace(trimmed.slice("/workspace ".length).trim());
      activeChannel = await selectConversation(store, "general");
      status = `Switched to workspace ${workspace.slug}`;
      showHelp = false;
      return;
    }
    if (trimmed.startsWith("/")) {
      status = "Unknown command. Type /help.";
      return;
    }
    const sent = await store.sendMessage(activeChannel.id, trimmed);
    const messages = store.recent(activeChannel.id, 200);
    status = messages.some((message) => message.id === sent.id) ? "" : "";
    showHelp = false;
    await store.markReadConversation(activeChannel.id);
  };

  emitKeypressEvents(input);
  if (input.isTTY) {
    input.setRawMode?.(true);
  }
  input.resume();

  const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
    void (async () => {
      try {
        if ((key.ctrl && key.name === "c") || key.sequence === "\u0003") {
          isOpen = false;
          return;
        }
        if (key.name === "return") {
          const submitted = inputText;
          inputText = "";
          await runLine(submitted);
        } else if (key.name === "backspace") {
          inputText = inputText.slice(0, -1);
        } else if (key.name === "up") {
          await moveSelection(-1);
          return;
        } else if (key.name === "down" || key.name === "tab") {
          await moveSelection(1);
          return;
        } else if (key.name === "escape") {
          showHelp = false;
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
