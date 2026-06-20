import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const agentMocks = vi.hoisted(() => ({
  runConversationalAgentForThaneChatMessage: vi.fn()
}));

vi.mock("../src/services/agent-runtime", () => ({
  runConversationalAgentForThaneChatMessage: agentMocks.runConversationalAgentForThaneChatMessage
}));

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signWebhookBody(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return `v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

describe("Thane Chat webhook receiver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs Ask Thane from a signed team webhook and reacts when a task is created", async () => {
    agentMocks.runConversationalAgentForThaneChatMessage.mockResolvedValue({
      usedTools: true,
      createdTaskIds: ["task_1"],
      updatedTaskIds: [],
      taskActionTypes: ["create"],
      eventTypes: [],
      finalSummary: "created one task"
    });

    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const insertedReactions: Array<{ args: unknown[] }> = [];
    const first = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_webhooks")) {
        return {
          id: "twh_ask",
          workspace_id: "wsp_1",
          name: "Ask Thane",
          signing_secret: "whsec_test",
          bot_member_id: "tcm_thane",
          status: "active"
        };
      }
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("id = ?")) {
        return {
          id: "tcm_owner",
          account_id: "acct_owner",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner"
        };
      }
      if (sql.includes("FROM thane_cli_workspaces")) {
        return { id: "wsp_1", workspace_slug: "thane-internal", workspace_name: "Thane Internal" };
      }
      if (sql.includes("FROM thane_cli_channels")) {
        return { id: "tcc_1", kind: "channel", visibility: "public" };
      }
      if (sql.includes("FROM conversation_sources")) {
        return { id: "conv_1" };
      }
      return null;
    });
    const all = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("LIMIT 250")) {
        return {
          results: [
            {
              id: "tcm_owner",
              account_id: "acct_owner",
              email: "owner@example.com",
              display_name: "Owner",
              handle: "owner"
            },
            {
              id: "tcm_thane",
              account_id: "acct_thane",
              email: "thane@askthane.com",
              display_name: "Ask Thane",
              handle: "thane"
            }
          ]
        };
      }
      if (sql.includes("FROM thane_cli_channel_members")) {
        return { results: [{ member_id: "tcm_owner" }, { member_id: "tcm_thane" }] };
      }
      return { results: [] };
    });
    const run = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      if ((this.sql ?? "").includes("INSERT OR IGNORE INTO thane_cli_message_reactions")) {
        insertedReactions.push({ args: this.args ?? [] });
      }
      return { meta: { changes: 1 } };
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          run: run.bind({ sql, args }),
          first: first.bind({ sql, args }),
          all: all.bind({ sql, args })
        };
      })
    }));

    const body = JSON.stringify({
      id: "tdlv_1",
      type: "message.created",
      workspaceId: "wsp_1",
      channelId: "tcc_1",
      message: {
        id: "tmsg_1",
        workspaceId: "wsp_1",
        channelId: "tcc_1",
        authorId: "tcm_owner",
        authorHandle: "owner",
        authorDisplayName: "Owner",
        text: "To do: invite the team",
        source: "chat",
        createdAt: "2026-06-20T14:19:17.176Z"
      }
    });
    const timestamp = new Date().toISOString();
    const response = await worker.fetch(
      new Request("https://bot.local/webhooks/thane-chat/events", {
        method: "POST",
        headers: {
          "x-thane-webhook-id": "twh_ask",
          "x-thane-timestamp": timestamp,
          "x-thane-signature": await signWebhookBody("whsec_test", timestamp, body)
        },
        body
      }),
      { DB: { prepare } } as never,
      {} as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      createdTaskIds: ["task_1"],
      reactions: ["📝"]
    });
    expect(agentMocks.runConversationalAgentForThaneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_thane_wsp_1",
        workspaceId: "wsp_1",
        conversationSourceId: "conv_1",
        channelId: "tcc_1",
        authorExternalUserId: "owner@example.com",
        authorEmail: "owner@example.com",
        interactionMode: "passive_ingest"
      })
    );
    expect(insertedReactions).toHaveLength(1);
    expect(insertedReactions[0]?.args[1]).toBe("tmsg_1");
    expect(insertedReactions[0]?.args[2]).toBe("tcm_thane");
    expect(insertedReactions[0]?.args[3]).toBe("📝");
    expect(calls.some((call) => call.sql.includes("UPDATE thane_cli_ask_thane_integrations SET last_event_at"))).toBe(true);
  });
});
