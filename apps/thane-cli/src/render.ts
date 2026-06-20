import type { ConversationSummary, MessageView, ThaneAccount, ThaneChannel, ThaneUser, ThaneWorkspace, WorkspaceRole } from "./model.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function renderChannels(channels: ThaneChannel[]): string {
  if (channels.length === 0) {
    return "No channels yet.";
  }
  return channels
    .map((channel) => `#${channel.name} (${channel.visibility})${channel.topic ? ` - ${channel.topic}` : ""}`)
    .join("\n");
}

export function renderDms(dms: ThaneChannel[], labelForDm: (dm: ThaneChannel) => string = (dm) => `@${dm.name}`): string {
  if (dms.length === 0) {
    return "No DMs yet.";
  }
  return dms.map((dm) => labelForDm(dm)).join("\n");
}

export function renderUsers(users: ThaneUser[]): string {
  if (users.length === 0) {
    return "No users yet.";
  }
  return users.map((user) => `${user.displayName || `@${user.handle}`} @${user.handle}`).join("\n");
}

export function renderMembers(
  members: Array<{ user: ThaneUser; account?: ThaneAccount; role: WorkspaceRole; joinedAt: string }>
): string {
  if (members.length === 0) {
    return "No members yet.";
  }
  return members
    .map((member) => {
      const email = member.account?.email ?? member.user.email;
      return `${member.user.displayName || `@${member.user.handle}`} @${member.user.handle} (${member.role})${email ? ` - ${email}` : ""}`;
    })
    .join("\n");
}

export function renderWorkspaces(workspaces: ThaneWorkspace[], activeWorkspaceId: string): string {
  if (workspaces.length === 0) {
    return "No teams yet.";
  }
  return workspaces
    .map((workspace) => `${workspace.id === activeWorkspaceId ? "*" : " "} ${workspace.slug} - ${workspace.name}`)
    .join("\n");
}

export function renderInbox(summaries: ConversationSummary[]): string {
  if (summaries.length === 0) {
    return "No unread conversations.";
  }
  return summaries
    .map((summary) => {
      const conversation = summary.conversationKind === "dm" ? summary.conversation : `#${summary.conversation}`;
      const mention = summary.mentionCount > 0 ? `, ${summary.mentionCount} mention${summary.mentionCount === 1 ? "" : "s"}` : "";
      const latest = summary.latestText ? ` - ${summary.latestAuthor ?? "unknown"}: ${summary.latestText}` : "";
      return `${summary.workspace} ${conversation}  ${summary.unreadCount} unread${mention}${latest}`;
    })
    .join("\n");
}

export function renderMessages(messages: MessageView[]): string {
  if (messages.length === 0) {
    return "No messages found.";
  }
  return messages.map(renderMessage).join("\n");
}

function isWorkspaceJoinMessage(message: MessageView): boolean {
  return message.id.startsWith("evt_join_") || message.id.startsWith("tjoin_");
}

export function renderMessage(message: MessageView): string {
  const date = new Date(message.createdAt);
  const stamp = Number.isNaN(date.getTime()) ? message.createdAt : date.toLocaleString();
  const conversation = message.conversationKind === "dm" ? message.channel : `#${message.channel}`;
  if (isWorkspaceJoinMessage(message)) {
    return `[${stamp}] ${conversation} * ${message.text}\n  id: ${message.id}`;
  }
  const thread = message.replyCount > 0 ? `  thread: ${message.replyCount} replies` : "";
  const reply = message.threadRootId ? `  in-thread:${message.threadRootId}` : "";
  const reactions =
    message.reactions.length > 0 ? `  reactions: ${message.reactions.map((reaction) => reaction.emoji).join(" ")}` : "";
  const mention = message.mentionsMe ? "  mentions you" : "";
  return `[${stamp}] ${conversation} ${message.author}: ${message.text}\n  id: ${message.id}${thread}${reply}${reactions}${mention}`;
}
