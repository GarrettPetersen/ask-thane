import type { MessageEvent, UserRef } from "@ask-thane/domain";

export interface SlackEnvelope {
  team_id?: string;
  event?: {
    channel?: string;
    ts?: string;
    text?: string;
    user?: string;
  };
}

export function slackUser(userId: string): UserRef {
  return {
    platform: "slack",
    platformUserId: userId
  };
}

export function normalizeSlackEvent(input: SlackEnvelope): MessageEvent | null {
  if (!input.team_id || !input.event?.channel || !input.event.ts || !input.event.user || !input.event.text) {
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
