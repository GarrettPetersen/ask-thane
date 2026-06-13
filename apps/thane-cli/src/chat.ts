import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runSlashMenu } from "./menu.js";
import { renderInbox, renderMessages, renderUsers, renderWorkspaces } from "./render.js";
import { completeSlashCommand, renderSlashCommands, slashCommands } from "./slash-commands.js";
import { ThaneStore } from "./store.js";

async function selectChannel(store: ThaneStore, target: string): Promise<{ channelId: string; promptName: string }> {
  if (target.startsWith("@")) {
    const dm = await store.findOrCreateDm(target.slice(1));
    return { channelId: dm.id, promptName: `@${dm.name}` };
  }
  const channel = await store.createChannel(target);
  return { channelId: channel.id, promptName: `#${channel.name}` };
}

export async function runChat(initialChannel = "general"): Promise<void> {
  let store = await ThaneStore.open();
  let { channelId: channel, promptName } = await selectChannel(store, initialChannel);
  let lastSeenAt = store.recent(channel, 50).at(-1)?.createdAt ?? "";
  let lastActivitySignature = "";
  const rl = createInterface({
    input,
    output,
    prompt: `${store.activeWorkspace.slug}${promptName}> `,
    completer: completeSlashCommand
  });
  let isOpen = true;

  const poll = setInterval(() => {
    void (async () => {
      if (!isOpen) {
        return;
      }
      const freshStore = await ThaneStore.open();
      const freshMessages = freshStore.recent(channel, 50).filter((message) => message.createdAt > lastSeenAt);
      if (freshMessages.length === 0) {
        store = freshStore;
        const activity = freshStore
          .inbox({ allWorkspaces: true, onlyUnread: true })
          .filter((summary) => !(summary.workspaceId === freshStore.activeWorkspace.id && summary.conversationId === channel));
        const signature = JSON.stringify(activity.map((summary) => [summary.workspaceId, summary.conversationId, summary.unreadCount, summary.mentionCount]));
        if (activity.length > 0 && signature !== lastActivitySignature) {
          lastActivitySignature = signature;
          output.write(`\nActivity elsewhere:\n${renderInbox(activity)}\n`);
          rl.prompt();
        }
        return;
      }
      lastSeenAt = freshMessages.at(-1)?.createdAt ?? lastSeenAt;
      store = freshStore;
      output.write(`\n${renderMessages(freshMessages)}\n`);
      rl.prompt();
    })().catch((error) => {
      output.write(`\n${(error as Error).message}\n`);
      rl.prompt();
    });
  }, 2_000);

  output.write(`Thane chat - workspace ${store.activeWorkspace.slug}\n`);
  output.write("Type /commands to see commands, /menu for an arrow-key menu, or press Tab after / for completion.\n\n");
  output.write(`${renderMessages(store.recent(channel, 20))}\n\n`);
  rl.prompt();

  const runSlashLine = async (trimmed: string): Promise<"continue" | "quit"> => {
    if (trimmed === "/quit" || trimmed === "/exit") {
      return "quit";
    }
    if (trimmed === "/commands") {
      output.write(`${renderSlashCommands()}\n`);
    } else if (trimmed === "/menu") {
      rl.pause();
      const selected = await runSlashMenu(slashCommands);
      rl.resume();
      if (selected) {
        if (selected.needsArgument) {
          output.write(`${selected.usage} - ${selected.description}\n`);
        } else {
          return runSlashLine(selected.name);
        }
      }
    } else if (trimmed === "/inbox") {
      output.write(`${renderInbox(store.inbox({ onlyUnread: true }))}\n`);
    } else if (trimmed === "/inbox all") {
      output.write(`${renderInbox(store.inbox({ allWorkspaces: true, onlyUnread: true }))}\n`);
    } else if (trimmed === "/workspaces") {
      output.write(`${renderWorkspaces(store.listWorkspaces(), store.activeWorkspace.id)}\n`);
    } else if (trimmed.startsWith("/workspace ")) {
      const workspace = await store.useWorkspace(trimmed.slice("/workspace ".length).trim());
      ({ channelId: channel, promptName } = await selectChannel(store, "general"));
      lastSeenAt = store.recent(channel, 50).at(-1)?.createdAt ?? "";
      lastActivitySignature = "";
      rl.setPrompt(`${workspace.slug}${promptName}> `);
      output.write(`${renderMessages(store.recent(channel, 20))}\n`);
    } else if (trimmed === "/channels") {
      output.write(`${store.listChannels().map((item) => `#${item.name}`).join("\n")}\n`);
    } else if (trimmed.startsWith("/join ")) {
      ({ channelId: channel, promptName } = await selectChannel(store, trimmed.slice("/join ".length).trim()));
      lastSeenAt = store.recent(channel, 50).at(-1)?.createdAt ?? "";
      lastActivitySignature = "";
      rl.setPrompt(`${store.activeWorkspace.slug}${promptName}> `);
      output.write(`${renderMessages(store.recent(channel, 20))}\n`);
    } else if (trimmed === "/leave") {
      if (promptName.startsWith("@")) {
        output.write("DMs cannot be left in the MVP.\n");
      } else {
        const leftChannel = await store.leaveChannel(promptName.slice(1));
        ({ channelId: channel, promptName } = await selectChannel(store, "general"));
        lastSeenAt = store.recent(channel, 50).at(-1)?.createdAt ?? "";
        lastActivitySignature = "";
        rl.setPrompt(`${store.activeWorkspace.slug}${promptName}> `);
        output.write(`left #${leftChannel.name}\n${renderMessages(store.recent(channel, 20))}\n`);
      }
    } else if (trimmed === "/members") {
      if (promptName.startsWith("@")) {
        output.write("DM membership is just the two participants.\n");
      } else {
        output.write(`${renderUsers(store.channelMembers(promptName.slice(1)))}\n`);
      }
    } else if (trimmed.startsWith("/dm ")) {
      ({ channelId: channel, promptName } = await selectChannel(store, `@${trimmed.slice("/dm ".length).trim()}`));
      lastSeenAt = store.recent(channel, 50).at(-1)?.createdAt ?? "";
      lastActivitySignature = "";
      rl.setPrompt(`${store.activeWorkspace.slug}${promptName}> `);
      output.write(`${renderMessages(store.recent(channel, 20))}\n`);
    } else if (trimmed === "/recent") {
      output.write(`${renderMessages(store.recent(channel, 20))}\n`);
    } else if (trimmed.startsWith("/thread ")) {
      output.write(`${renderMessages(store.thread(trimmed.slice("/thread ".length).trim()))}\n`);
    } else if (trimmed.startsWith("/reply ")) {
      const [messageId, ...textParts] = trimmed.slice("/reply ".length).trim().split(/\s+/);
      if (!messageId || textParts.length === 0) {
        output.write("Usage: /reply <message-id> <text>\n");
      } else {
        const message = await store.reply(messageId, textParts.join(" "));
        output.write(`sent ${message.id}\n`);
      }
    } else if (trimmed.startsWith("/react ")) {
      const [messageId, emoji] = trimmed.slice("/react ".length).trim().split(/\s+/);
      if (!messageId || !emoji) {
        output.write("Usage: /react <message-id> <emoji>\n");
      } else {
        await store.react(messageId, emoji);
        output.write(`reacted to ${messageId}\n`);
      }
    } else if (trimmed.startsWith("/search ")) {
      output.write(`${renderMessages(store.search(trimmed.slice("/search ".length).trim()))}\n`);
    } else if (trimmed.startsWith("/")) {
      output.write(`Unknown command. Type /commands to see commands.\n`);
    } else {
      const message = await store.sendMessage(channel, trimmed);
      lastSeenAt = message.createdAt;
      output.write(`sent ${message.id}\n`);
    }
    return "continue";
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    try {
      if (!trimmed) {
        rl.prompt();
        continue;
      }
      const result = await runSlashLine(trimmed);
      if (result === "quit") {
        break;
      }
    } catch (error) {
      output.write(`${(error as Error).message}\n`);
    }
    rl.prompt();
  }

  isOpen = false;
  clearInterval(poll);
  rl.close();
}
