import type { MessageEvent, UserRef } from "@ask-thane/domain";

export interface SlackEnvelope {
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    user?: string;
    channel_type?: string;
  };
}

export interface SlackMembershipEvent {
  externalWorkspaceId: string;
  channelId: string;
  userId: string;
  action: "joined" | "left";
  occurredAt: string;
  conversationKind: "public_channel" | "private_channel" | "group_dm" | "dm";
  isPublic: boolean;
}

export function slackUser(userId: string): UserRef {
  return {
    platform: "slack",
    platformUserId: userId
  };
}

export function normalizeSlackEvent(input: SlackEnvelope): MessageEvent | null {
  const eventType = input.event?.type;
  const isSupportedMessageType = eventType === "message" || eventType === "app_mention";

  if (
    !input.team_id ||
    !input.event?.channel ||
    !input.event.ts ||
    !input.event.user ||
    !input.event.text ||
    !isSupportedMessageType ||
    input.event.subtype === "bot_message" ||
    Boolean(input.event.bot_id)
  ) {
    return null;
  }

  return {
    workspaceId: input.team_id,
    channelId: input.event.channel,
    messageId: input.event.ts,
    text: input.event.text,
    author: slackUser(input.event.user),
    occurredAt: new Date(Number(input.event.ts.split(".")[0]) * 1000).toISOString()
  };
}

export function normalizeSlackMembershipEvent(input: SlackEnvelope): SlackMembershipEvent | null {
  if (!input.team_id || !input.event?.channel || !input.event.user || !input.event.type) {
    return null;
  }

  if (input.event.type !== "member_joined_channel" && input.event.type !== "member_left_channel") {
    return null;
  }

  return {
    externalWorkspaceId: input.team_id,
    channelId: input.event.channel,
    userId: input.event.user,
    action: input.event.type === "member_joined_channel" ? "joined" : "left",
    occurredAt: new Date((input.event_time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    ...inferSlackConversationKind(input.event.channel, input.event.channel_type)
  };
}

export function inferSlackConversationKind(
  channelId: string,
  channelType?: string
): { conversationKind: SlackMembershipEvent["conversationKind"]; isPublic: boolean } {
  if (channelType === "channel") {
    return { conversationKind: "public_channel", isPublic: true };
  }
  if (channelType === "group") {
    return { conversationKind: "private_channel", isPublic: false };
  }
  if (channelType === "im") {
    return { conversationKind: "dm", isPublic: false };
  }
  if (channelType === "mpim") {
    return { conversationKind: "group_dm", isPublic: false };
  }

  if (channelId.startsWith("C")) {
    return { conversationKind: "public_channel", isPublic: true };
  }
  if (channelId.startsWith("G")) {
    return { conversationKind: "private_channel", isPublic: false };
  }
  if (channelId.startsWith("D")) {
    return { conversationKind: "dm", isPublic: false };
  }

  return { conversationKind: "private_channel", isPublic: false };
}
