import { describe, expect, it } from "vitest";
import {
  inferSlackConversationKind,
  normalizeSlackEvent,
  normalizeSlackMembershipEvent,
  slackUser
} from "../src/index";

describe("@ask-thane/integrations", () => {
  it("normalizes supported Slack message events", () => {
    const result = normalizeSlackEvent({
      team_id: "T1",
      event: {
        type: "message",
        channel: "C123",
        ts: "1710000000.000001",
        text: "Pack the van",
        user: "U1"
      }
    });

    expect(result).toMatchObject({
      workspaceId: "T1",
      channelId: "C123",
      messageId: "1710000000.000001",
      text: "Pack the van",
      author: { platform: "slack", platformUserId: "U1" }
    });
    expect(result?.occurredAt).toBe("2024-03-09T16:00:00.000Z");
  });

  it("rejects bot-originated Slack events", () => {
    const result = normalizeSlackEvent({
      team_id: "T1",
      event: {
        type: "message",
        channel: "C123",
        ts: "1710000000.000001",
        text: "Automated update",
        user: "U1",
        bot_id: "B1"
      }
    });
    expect(result).toBeNull();
  });

  it("normalizes membership join events with inferred kind", () => {
    const result = normalizeSlackMembershipEvent({
      team_id: "T1",
      event_time: 1710000000,
      event: {
        type: "member_joined_channel",
        channel: "D123",
        user: "U1"
      }
    });

    expect(result).toEqual({
      externalWorkspaceId: "T1",
      channelId: "D123",
      userId: "U1",
      action: "joined",
      occurredAt: "2024-03-09T16:00:00.000Z",
      conversationKind: "dm",
      isPublic: false
    });
  });

  it("infers conversation kind from channel_type and channel id fallback", () => {
    expect(inferSlackConversationKind("C000", "channel")).toEqual({
      conversationKind: "public_channel",
      isPublic: true
    });
    expect(inferSlackConversationKind("G000")).toEqual({
      conversationKind: "private_channel",
      isPublic: false
    });
  });

  it("builds Slack user refs", () => {
    expect(slackUser("U123")).toEqual({
      platform: "slack",
      platformUserId: "U123"
    });
  });
});
