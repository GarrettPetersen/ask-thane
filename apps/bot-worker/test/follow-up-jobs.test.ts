import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowUpJobRecord } from "@ask-thane/data";

const agentMocks = vi.hoisted(() => ({
  runProactiveFollowUpForThaneChatUser: vi.fn()
}));

vi.mock("../src/services/agent-runtime", () => ({
  runProactiveFollowUpForSlackUser: vi.fn(),
  runProactiveFollowUpForThaneChatUser: agentMocks.runProactiveFollowUpForThaneChatUser
}));

const { __testables } = await import("../src/services/follow-up-jobs");

describe("follow-up jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("dispatches native Thane Chat follow-ups through the Ask Thane app webhook", async () => {
    agentMocks.runProactiveFollowUpForThaneChatUser.mockResolvedValue({
      usedTools: true,
      createdTaskIds: [],
      updatedTaskIds: [],
      taskActionTypes: [],
      eventTypes: [],
      replyText: "Checking in: did the launch note get sent?"
    });

    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, message: { id: "tmsg_followup", channelId: "tcc_dm_thane_garrett" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_ask_thane_integrations")) {
        return { enabled: 1 };
      }
      if (sql.includes("FROM thane_cli_webhooks")) {
        return { id: "twh_ask" };
      }
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("email = ? OR handle = ?")) {
        return {
          id: "tcm_garrett",
          email: "garrett@example.com",
          display_name: "Garrett",
          handle: "garrett"
        };
      }
      if (sql.includes("FROM conversation_sources")) {
        return { id: "conv_src_general", provider_conversation_id: "tcc_general" };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          first: first.bind({ sql, args }),
          run: run.bind({ sql, args })
        };
      })
    }));
    const job: FollowUpJobRecord = {
      id: "fup_1",
      organizationId: "org_thane_wsp_1",
      workspaceId: "wsp_1",
      userId: "usr_thane_garrett",
      externalUserId: "garrett@example.com",
      prompt: "Check whether the launch note got sent",
      sourceConversationSourceId: "conv_src_general",
      scheduleAt: "2026-06-20T15:00:00.000Z",
      status: "pending",
      createdAt: "2026-06-20T14:00:00.000Z",
      updatedAt: "2026-06-20T14:00:00.000Z"
    };

    const result = await __testables.dispatchNativeFollowUp({
      env: { DB: { prepare } as unknown as D1Database } as never,
      job,
      destination: {
        platform: "thane_cli",
        externalUserId: "garrett@example.com",
        email: "garrett@example.com",
        displayName: "Garrett"
      },
      nowIso: "2026-06-20T15:00:00.000Z"
    });

    expect(result).toMatchObject({
      text: "Checking in: did the launch note get sent?",
      channelId: "tcc_dm_thane_garrett",
      messageTs: "tmsg_followup"
    });
    expect(agentMocks.runProactiveFollowUpForThaneChatUser).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_thane_wsp_1",
        workspaceId: "wsp_1",
        channelId: "tcc_general",
        conversationSourceId: "conv_src_general",
        externalUserId: "garrett@example.com",
        authorEmail: "garrett@example.com"
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.askthane.com/v1/thane-cli/webhooks/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          dmTarget: "garrett@example.com",
          text: "Checking in: did the launch note get sent?"
        })
      })
    );
    expect(calls.some((call) => call.sql.includes("INSERT INTO thane_cli_channels"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("INSERT INTO thane_cli_chat_messages"))).toBe(false);
  });
});
