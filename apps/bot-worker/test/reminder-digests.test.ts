import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@ask-thane/domain";
import { __testables } from "../src/services/reminder-digests";

function sampleTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    workspaceId: "ws_1",
    primaryConversationSourceId: "conv_1",
    channelId: "C1",
    sourceMessageId: "m1",
    title: "Pack the van",
    description: "Bring tie-down straps",
    assignee: { platform: "slack", platformUserId: "U_ASSIGNEE", displayName: "Garrett" },
    assigner: { platform: "slack", platformUserId: "U_ASSIGNER", displayName: "Danika" },
    createdAt: "2026-05-14T20:00:00.000Z",
    urgency: "high",
    difficulty: "medium",
    status: "incomplete",
    confidence: 0.9,
    metadata: {},
    ...overrides
  };
}

function makeDbStub() {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn(() => ({
    bind: vi.fn(() => ({ run }))
  }));
  return { prepare, run };
}

describe("reminder digests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses AI digests only for paid tiers", () => {
    expect(__testables.shouldUseAiDigest("free")).toBe(false);
    expect(__testables.shouldUseAiDigest("team")).toBe(true);
    expect(__testables.shouldUseAiDigest("growth")).toBe(true);
  });

  it("maps DM history into compact digest context", () => {
    const rows = __testables.toDigestContextMessages({
      recipientExternalUserId: "U_RECIPIENT",
      botUserId: "U_BOT",
      messages: [
        { user: "U_RECIPIENT", text: "Can you remind me about the van?" },
        { user: "U_BOT", text: "I have that task tracked." },
        { user: "U_OTHER", text: "I can help too." },
        { subtype: "channel_join", text: "noise" }
      ]
    });

    expect(rows).toEqual([
      { speaker: "recipient", text: "Can you remind me about the van?" },
      { speaker: "thane", text: "I have that task tracked." },
      { speaker: "other", text: "I can help too." }
    ]);
  });

  it("marks external/stranger users as non-remindable", () => {
    expect(
      __testables.isDmRemindableForInstall({
        profile: { id: "U1", isStranger: true },
        install: { botToken: "xoxb", externalWorkspaceId: "T_HOME" }
      })
    ).toMatchObject({ remindable: false, reason: "is_stranger" });

    expect(
      __testables.isDmRemindableForInstall({
        profile: { id: "U2", teamId: "T_OTHER" },
        install: { botToken: "xoxb", externalWorkspaceId: "T_HOME" }
      })
    ).toMatchObject({ remindable: false, reason: "foreign_team" });

    expect(
      __testables.isDmRemindableForInstall({
        profile: { id: "U3", teamId: "T_HOME" },
        install: { botToken: "xoxb", externalWorkspaceId: "T_HOME" }
      })
    ).toMatchObject({ remindable: true });
  });

  it("builds AI digest message and records usage", async () => {
    const db = makeDbStub();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Morning check-in: Pack the van is still urgent." } }],
            usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
          }),
          { status: 200 }
        )
      )
    );

    const text = await __testables.buildAiDigestMessage({
      env: {
        DB: db as unknown as D1Database,
        OPENAI_API_KEY: "test-key",
        OPENAI_PRICE_PROMPT_PER_1K_USD: "0.001",
        OPENAI_PRICE_COMPLETION_PER_1K_USD: "0.002"
      },
      organizationId: "org_0",
      workspaceId: "ws_1",
      cadence: {
        id: "cad_1",
        organizationId: "org_0",
        workspaceId: "ws_1",
        userId: "user_1",
        platform: "slack",
        externalUserId: "U_RECIPIENT",
        isEnabled: true,
        timezone: "America/Vancouver",
        cadenceJson: { kind: "workday_daily", times: ["09:00"] },
        cadenceSummary: "Once per working day",
        nextDigestAt: "2026-05-15T16:00:00.000Z",
        lastDigestAt: "2026-05-14T16:00:00.000Z",
        createdAt: "2026-05-14T16:00:00.000Z",
        updatedAt: "2026-05-14T16:00:00.000Z"
      },
      taskCount: 1,
      tasks: [sampleTask()],
      contextMessages: [{ speaker: "recipient", text: "I need to finish this today." }],
      model: "gpt-5.4-mini"
    });

    expect(text).toContain("Pack the van");
    expect(db.prepare).toHaveBeenCalled();
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it("dispatches native Thane Chat digests into DMs", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, message: { id: "tmsg_digest", channelId: "tcc_dm_thane_garrett" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_ask_thane_integrations")) {
        return { enabled: 1 };
      }
      if (sql.includes("FROM thane_cli_webhooks")) {
        return { id: "twh_ask" };
      }
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return { id: "tcm_garrett", email: "garrett@example.com", handle: "garrett" };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return { first: first.bind({ sql }), run };
      })
    }));
    const repo = {
      listOpenByAssigneeInOrganization: vi.fn(async () => [
        sampleTask({
          workspaceId: "wsp_1",
          assignee: { platform: "thane_cli", platformUserId: "garrett", displayName: "Garrett" },
          assigner: { platform: "thane_cli", platformUserId: "danika", displayName: "Danika" }
        })
      ]),
      recordDigestDelivery: vi.fn(async () => undefined),
      setUserNotificationCadenceDigestTimes: vi.fn(async () => undefined)
    };

    const outcome = await __testables.dispatchNativeCadenceDigest({
      env: { DB: { prepare } as unknown as D1Database },
      repo: repo as never,
      nowIso: "2026-06-19T16:00:00.000Z",
      cadence: {
        id: "cad_1",
        organizationId: "wsp_1",
        workspaceId: "wsp_1",
        userId: "usr_thane_tcm_garrett",
        platform: "thane_cli",
        externalUserId: "garrett",
        isEnabled: true,
        timezone: "America/Vancouver",
        cadenceJson: { kind: "workday_daily", times: ["09:00"] },
        cadenceSummary: "Once per working day",
        nextDigestAt: "2026-06-19T16:00:00.000Z",
        lastDigestAt: null,
        createdAt: "2026-06-18T16:00:00.000Z",
        updatedAt: "2026-06-18T16:00:00.000Z"
      },
      options: { forceSendNoTasks: false }
    });

    expect(outcome).toBe("sent");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.askthane.com/v1/thane-cli/webhooks/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"dmTarget":"garrett@example.com"')
      })
    );
    expect(calls.some((call) => call.sql.includes("INSERT INTO thane_cli_channels"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("INSERT INTO thane_cli_chat_messages"))).toBe(false);
    expect(repo.recordDigestDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        taskCount: 1,
        deliveryChannelId: "tcc_dm_thane_garrett",
        sourceMessageId: "tmsg_digest"
      })
    );
  });

  it("skips native Thane Chat digests when Ask Thane is not enabled", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_ask_thane_integrations")) {
        return { enabled: 0 };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return { first: first.bind({ sql }), run };
      })
    }));
    const repo = {
      listOpenByAssigneeInOrganization: vi.fn(async () => [
        sampleTask({
          workspaceId: "wsp_1",
          assignee: { platform: "thane_cli", platformUserId: "garrett", displayName: "Garrett" },
          assigner: { platform: "thane_cli", platformUserId: "danika", displayName: "Danika" }
        })
      ]),
      recordDigestDelivery: vi.fn(async () => undefined),
      setUserNotificationCadenceDigestTimes: vi.fn(async () => undefined)
    };

    const outcome = await __testables.dispatchNativeCadenceDigest({
      env: { DB: { prepare } as unknown as D1Database },
      repo: repo as never,
      nowIso: "2026-06-19T16:00:00.000Z",
      cadence: {
        id: "cad_1",
        organizationId: "wsp_1",
        workspaceId: "wsp_1",
        userId: "usr_thane_tcm_garrett",
        platform: "thane_cli",
        externalUserId: "garrett",
        isEnabled: true,
        timezone: "America/Vancouver",
        cadenceJson: { kind: "workday_daily", times: ["09:00"] },
        cadenceSummary: "Once per working day",
        nextDigestAt: "2026-06-19T16:00:00.000Z",
        lastDigestAt: null,
        createdAt: "2026-06-18T16:00:00.000Z",
        updatedAt: "2026-06-18T16:00:00.000Z"
      },
      options: { forceSendNoTasks: false }
    });

    expect(outcome).toBe("skipped_unremindable_assignee");
    expect(repo.listOpenByAssigneeInOrganization).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("INSERT INTO thane_cli_chat_messages"))).toBe(false);
    expect(repo.recordDigestDelivery).not.toHaveBeenCalled();
  });
});
