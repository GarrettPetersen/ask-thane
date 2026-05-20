import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@ask-thane/domain";
import { __testables } from "../src/services/agent-runtime";

vi.mock("../src/services/slack-api", () => ({
  fetchSlackConversationHistory: vi.fn(async () => [
    {
      user: "U_OTHER",
      ts: "1710000000.000001",
      text: "sample context",
      reactions: [{ name: "eyes", users: ["U0B2T03RPD0"] }]
    }
  ]),
  fetchSlackThreadReplies: vi.fn(async () => [
    {
      user: "U0B2QTLPABY",
      ts: "1710000001.000001",
      thread_ts: "1710000000.000001",
      text: "thread context"
    }
  ])
}));

function sampleTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    workspaceId: "ws_1",
    primaryConversationSourceId: "conv_1",
    channelId: "C1",
    sourceMessageId: "m1",
    title: "Pack the van",
    description: "Initial details",
    assignee: { platform: "slack", platformUserId: "U0B2T03RPD0", displayName: "Garrett Petersen" },
    assigner: { platform: "slack", platformUserId: "U0B2T03RPD0", displayName: "Garrett Petersen" },
    createdAt: "2026-05-14T20:00:00.000Z",
    urgency: "medium",
    difficulty: "medium",
    status: "incomplete",
    confidence: 0.9,
    metadata: {},
    ...overrides
  };
}

function makeDbStub() {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const all = vi.fn(async () => ({ results: [] }));
  const first = vi.fn(async () => null);
  const bind = vi.fn(() => ({ run, all, first }));
  const prepare = vi.fn(() => ({ bind }));
  return { prepare, bind, run, all, first };
}

function makeBillingCapDbStub(input: { activeExternalUserIds: string[]; activeUsersCount: number }) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const all = vi.fn(async () => ({ results: [] }));
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      run,
      all,
      first: vi.fn(async () => {
        if (sql.includes("effective_plan_tier")) {
          return {
            effective_plan_tier: "free",
            included_active_users: 10,
            hard_cap_active_users: 10,
            active_user_window_days: 30,
            overage_enabled: 0,
            is_enabled: 1
          };
        }
        if (sql.includes("FROM workspace_user_activity") && sql.includes("external_user_id = ?")) {
          const externalUserId = String(args[2] ?? "");
          if (input.activeExternalUserIds.includes(externalUserId)) {
            return { id: `activity_${externalUserId}` };
          }
          return null;
        }
        if (sql.includes("COUNT(*) AS active_users")) {
          return { active_users: input.activeUsersCount };
        }
        return null;
      })
    })
  }));
  return { prepare, run, all };
}

function makeRepoStub(overrides: Record<string, unknown> = {}) {
  return {
    searchTasksWithAcl: vi.fn(async () => []),
    listAgentNotes: vi.fn(async () => [
      {
        id: "note_1",
        content: "Durable note",
        visibility: "organization",
        authorType: "agent",
        createdAt: "2026-05-14T20:00:00.000Z"
      }
    ]),
    addAgentNote: vi.fn(async () => {}),
    listWorkspaceUsers: vi.fn(async () => [
      {
        userId: "user_garrett",
        externalUserId: "U0B2T03RPD0",
        displayName: "Garrett Petersen",
        email: "garrett@example.com"
      },
      {
        userId: "user_danika",
        externalUserId: "U0B2QTLPABY",
        displayName: "danika",
        email: "danika@example.com"
      }
    ]),
    getPersonByUserId: vi.fn(async (_orgId: string, userId: string) => ({ id: `person_${userId}` })),
    save: vi.fn(async () => {}),
    performTaskAction: vi.fn(async () => {}),
    getTaskByIdWithAcl: vi.fn(async () => sampleTask()),
    listTaskTimelineWithAcl: vi.fn(async () => [
      {
        id: "action_1",
        taskId: "task_1",
        actionType: "create",
        createdAt: "2026-05-14T20:00:00.000Z"
      }
    ]),
    requestPermissionWaiver: vi.fn(async () => {}),
    getUserNotificationCadence: vi.fn(async () => null),
    upsertUserNotificationCadence: vi.fn(async () => {}),
    enqueueFollowUpJob: vi.fn(async () => {}),
    ...overrides
  };
}

function makeResolverStub(overrides: Record<string, unknown> = {}) {
  return {
    getConversationSourceById: vi.fn(async () => ({
      id: "conv_1",
      workspaceId: "ws_1",
      providerConversationId: "C_TEST",
      conversationKind: "public_channel",
      isPublic: true
    })),
    listReadableConversationSources: vi.fn(async () => [
      {
        id: "conv_1",
        workspaceId: "ws_1",
        providerConversationId: "C_TEST",
        conversationKind: "public_channel",
        isPublic: true
      },
      {
        id: "conv_dm_1",
        workspaceId: "ws_1",
        providerConversationId: "D_TEST",
        conversationKind: "dm",
        isPublic: false
      }
    ]),
    ...overrides
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const db = makeDbStub();
  const repo = makeRepoStub();
  const resolver = makeResolverStub();
  const ctx: Record<string, unknown> = {
    env: { DB: db, AGENT_TOOL_READ_LIMIT: "100" },
    repo,
    resolver,
    installStore: {},
    organizationId: "org_0",
    workspaceId: "ws_1",
    externalWorkspaceId: "T0B2BG0JJ95",
    actorExternalUserId: "U0B2T03RPD0",
    actorInternalUserId: "user_garrett",
    actorPersonId: "person_user_garrett",
    readableConversationSourceIds: ["conv_1"],
    currentConversationSourceId: "conv_1",
    botToken: "xoxb-test",
    createdTaskIds: [],
    taskActionTypes: new Set<string>(),
    eventTypes: new Set<string>(),
    recentMessages: [],
    event: {
      workspaceId: "ws_1",
      channelId: "C1",
      messageId: "1710000000.000001",
      text: "sample text",
      author: { platform: "slack", platformUserId: "U0B2T03RPD0" },
      occurredAt: "2026-05-14T20:00:00.000Z"
    },
    interactionMode: "passive_ingest",
    readOnlyTools: false,
    botExternalUserId: "U_BOT",
    workspaceUsers: [
      { userId: "user_garrett", externalUserId: "U0B2T03RPD0", displayName: "Garrett Petersen" },
      { userId: "user_danika", externalUserId: "U0B2QTLPABY", displayName: "danika" }
    ],
    billingPolicy: {
      planTier: "team",
      monthlyBasePriceUsd: 99,
      includedActiveUsers: 25,
      perUserOverageUsd: 3,
      includedAiCostUsd: 20,
      aiOverageMultiplier: 1.35,
      hardCapActiveUsers: null,
      activeUserWindowDays: 30,
      overageEnabled: true,
      isEnabled: true
    },
    ...overrides
  };
  return { ctx, db, repo, resolver };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  contextOverrides: Record<string, unknown> = {}
) {
  const { ctx, db, repo, resolver } = makeContext(contextOverrides);
  const updatedTaskIds = new Set<string>();
  const notesWrittenCountRef = { count: 0 };
  const waiversRequestedCountRef = { count: 0 };
  const finalReplyRef: { text?: string; finalized: boolean } = { finalized: false };

  const toolCall = {
    id: "call_1",
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };

  const result = await __testables.executeTool(
    toolCall as never,
    ctx as never,
    updatedTaskIds,
    notesWrittenCountRef,
    waiversRequestedCountRef,
    finalReplyRef
  );

  return {
    result,
    ctx,
    db,
    repo,
    resolver,
    updatedTaskIds,
    notesWrittenCountRef,
    waiversRequestedCountRef,
    finalReplyRef
  };
}

describe("agent runtime tool definitions", () => {
  it("includes all tools in dm_reply mode", () => {
    const names = __testables.toolDefinitions("dm_reply").map((tool) => tool.function.name);
    expect(names).toEqual([
      "search_tasks",
      "get_notes",
      "write_note",
      "get_conversation_context",
      "search_conversation_messages",
      "search_readable_conversations",
      "get_task_timeline",
      "search_workspace_people",
      "create_task",
      "update_task",
      "add_task_details",
      "request_permission_waiver",
      "record_feedback",
      "get_notification_cadence",
      "set_notification_cadence",
      "schedule_follow_up",
      "finalize_user_reply"
    ]);
  });

  it("excludes finalize_user_reply in passive_ingest mode", () => {
    const names = __testables.toolDefinitions("passive_ingest").map((tool) => tool.function.name);
    expect(names).not.toContain("finalize_user_reply");
  });

  it("keeps proactive_followup mode read-only", () => {
    const names = __testables.toolDefinitions("proactive_followup").map((tool) => tool.function.name);
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("update_task");
    expect(names).not.toContain("add_task_details");
    expect(names).toContain("search_tasks");
    expect(names).toContain("finalize_user_reply");
  });
});

describe("agent runtime tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finalize_user_reply works", async () => {
    const run = await runTool("finalize_user_reply", { reply_text: "  done.  " });
    expect(run.result).toEqual({ ok: true, finalized: true });
    expect(run.finalReplyRef.text).toBe("done.");
    expect(run.finalReplyRef.finalized).toBe(true);
  });

  it("record_feedback works without a real DB", async () => {
    const run = await runTool("record_feedback", {
      feedback_type: "not_a_task",
      task_id: "task_1",
      note: "this was context only",
      details: { source: "manual" }
    });
    expect(run.result).toMatchObject({ ok: true, feedback_type: "not_a_task", task_id: "task_1" });
    expect(run.db.prepare).toHaveBeenCalled();
    expect((run.ctx.eventTypes as Set<string>).has("feedback_recorded")).toBe(true);
  });

  it("search_tasks works", async () => {
    const run = await runTool(
      "search_tasks",
      {
        query: "pack",
        assignee_user_id: "U0B2T03RPD0",
        statuses: ["incomplete"],
        limit: 10
      },
      {
        repo: makeRepoStub({
          searchTasksWithAcl: vi.fn(async () => [sampleTask()])
        })
      }
    );
    expect(run.result).toMatchObject({ ok: true });
    expect(Array.isArray((run.result as Record<string, unknown>).tasks)).toBe(true);
    expect((run.ctx.repo as { searchTasksWithAcl: ReturnType<typeof vi.fn> }).searchTasksWithAcl).toHaveBeenCalled();
  });

  it("get_notes works", async () => {
    const run = await runTool("get_notes", {
      scope_type: "workspace",
      scope_id: "ws_1",
      limit: 5
    });
    expect(run.result).toMatchObject({ ok: true });
    expect(run.repo.listAgentNotes).toHaveBeenCalled();
  });

  it("write_note works", async () => {
    const run = await runTool("write_note", {
      scope_type: "person",
      scope_id: "person_user_danika",
      visibility: "conversation_acl",
      content: "Danika usually takes staging prep."
    });
    expect(run.result).toEqual({ ok: true });
    expect(run.repo.addAgentNote).toHaveBeenCalled();
    expect(run.notesWrittenCountRef.count).toBe(1);
    expect((run.ctx.eventTypes as Set<string>).has("note_written")).toBe(true);
  });

  it("get_conversation_context works", async () => {
    const run = await runTool("get_conversation_context", {
      conversation_source_id: "conv_1",
      limit: 10
    });
    expect(run.result).toMatchObject({ ok: true, conversation_source_id: "conv_1" });
    const messages = (run.result as Record<string, unknown>).messages;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(1);
  });

  it("get_conversation_context can include thread replies", async () => {
    const run = await runTool("get_conversation_context", {
      conversation_source_id: "conv_1",
      thread_ts: "1710000000.000001",
      limit: 10
    });
    expect(run.result).toMatchObject({ ok: true, conversation_source_id: "conv_1", thread_ts: "1710000000.000001" });
    const messages = (run.result as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.thread_ts).toBe("1710000000.000001");
  });

  it("search_conversation_messages returns grep-style matches with context", async () => {
    const run = await runTool("search_conversation_messages", {
      query: "thread",
      conversation_source_id: "conv_1",
      thread_ts: "1710000000.000001",
      context_window: 1
    });
    expect(run.result).toMatchObject({
      ok: true,
      conversation_source_id: "conv_1",
      query: "thread",
      thread_ts: "1710000000.000001"
    });
    const matches = (run.result as Record<string, unknown>).matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    const firstContext = matches[0]?.context as Array<Record<string, unknown>>;
    expect(firstContext).toHaveLength(2);
    expect((matches[0]?.match as Record<string, unknown>).text).toBe("thread context");
  });

  it("search_readable_conversations works", async () => {
    const run = await runTool("search_readable_conversations", {
      conversation_kind: "dm",
      query: "d_",
      limit: 20
    });
    expect(run.result).toMatchObject({ ok: true });
    const conversations = (run.result as Record<string, unknown>).conversations as Array<Record<string, unknown>>;
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversation_kind).toBe("dm");
  });

  it("get_task_timeline works", async () => {
    const run = await runTool("get_task_timeline", { task_id: "task_1", limit: 20 });
    expect(run.result).toMatchObject({ ok: true, task_id: "task_1" });
    expect(run.repo.listTaskTimelineWithAcl).toHaveBeenCalled();
  });

  it("search_workspace_people works", async () => {
    const run = await runTool("search_workspace_people", { query: "danika", limit: 20 });
    expect(run.result).toMatchObject({ ok: true });
    const people = (run.result as Record<string, unknown>).people as Array<Record<string, unknown>>;
    expect(people).toHaveLength(2);
    expect(people[1]?.person_id).toBe("person_user_danika");
  });

  it("create_task works for multiple assignees", async () => {
    const run = await runTool("create_task", {
      title: "Calibrate telescope mirror",
      description: "Bring the checklist",
      assignee_user_ids: ["U0B2T03RPD0", "U0B2QTLPABY"],
      urgency: "high",
      difficulty: "medium",
      due_at: "2026-05-15T17:00:00Z"
    });
    expect(run.result).toMatchObject({ ok: true });
    const taskIds = (run.result as Record<string, unknown>).task_ids as string[];
    expect(taskIds).toHaveLength(2);
    expect(run.repo.save).toHaveBeenCalledTimes(2);
    expect(run.repo.performTaskAction).toHaveBeenCalledTimes(2);
    expect((run.ctx.taskActionTypes as Set<string>).has("create")).toBe(true);
  });

  it("create_task returns potential_duplicate_tasks and lets agent decide", async () => {
    const duplicateTask = sampleTask({
      id: "task_dup_1",
      title: "Make hamburgers",
      description: "Pick buns",
      urgency: "medium",
      difficulty: "medium",
      dueAt: undefined
    });
    const run = await runTool(
      "create_task",
      {
        title: "Make hamburgers tonight",
        description: "Add pickles",
        assignee_user_id: "U0B2T03RPD0",
        urgency: "high",
        difficulty: "medium"
      },
      {
        repo: makeRepoStub({
          searchTasksWithAcl: vi.fn(async () => [duplicateTask])
        })
      }
    );

    expect(run.result).toMatchObject({
      ok: false,
      error: "potential_duplicate_tasks",
      potential_duplicates: [
        {
          assignee_user_id: "U0B2T03RPD0",
          task_id: "task_dup_1",
          title: "Make hamburgers"
        }
      ]
    });
    expect(run.repo.save).not.toHaveBeenCalled();
    const usedRepo = run.ctx.repo as { performTaskAction: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
    expect(usedRepo.performTaskAction).not.toHaveBeenCalled();
    expect(usedRepo.save).not.toHaveBeenCalled();
  });

  it("create_task can explicitly create a separate task when agent confirms", async () => {
    const duplicateTask = sampleTask({
      id: "task_dup_1",
      title: "Make hamburgers"
    });
    const run = await runTool(
      "create_task",
      {
        title: "Make hamburgers tonight",
        assignee_user_id: "U0B2T03RPD0",
        urgency: "high",
        difficulty: "medium",
        confirm_separate_task_when_similar: true
      },
      {
        repo: makeRepoStub({
          searchTasksWithAcl: vi.fn(async () => [duplicateTask])
        })
      }
    );

    expect(run.result).toMatchObject({ ok: true });
    const usedRepo = run.ctx.repo as { save: ReturnType<typeof vi.fn> };
    expect(usedRepo.save).toHaveBeenCalledTimes(1);
  });

  it("update_task works, including assignee updates", async () => {
    const run = await runTool("update_task", {
      task_id: "task_1",
      action_type: "edit",
      title: "Pack the van",
      assignee_user_id: "user_danika",
      urgency: "critical"
    });
    expect(run.result).toEqual({ ok: true, task_id: "task_1", action_type: "edit" });
    expect(run.repo.performTaskAction).toHaveBeenCalledTimes(1);
    const actionInput = run.repo.performTaskAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(actionInput.assigneeId).toBe("U0B2QTLPABY");
    expect((run.ctx.taskActionTypes as Set<string>).has("edit")).toBe(true);
  });

  it("add_task_details works and appends by default", async () => {
    const run = await runTool("add_task_details", {
      task_id: "task_1",
      details_text: "Bring snacks"
    });
    expect(run.result).toMatchObject({ ok: true, task_id: "task_1", replace_existing: false });
    const actionInput = run.repo.performTaskAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(actionInput.description).toBe("Initial details\n\nBring snacks");
    expect(run.updatedTaskIds.has("task_1")).toBe(true);
  });

  it("request_permission_waiver works", async () => {
    const run = await runTool("request_permission_waiver", {
      resource_type: "task",
      resource_id: "task_1",
      requested_scope_type: "conversation",
      requested_scope_id: "conv_1",
      reason: "Need cross-context confirmation"
    });
    expect(run.result).toEqual({ ok: true });
    expect(run.repo.requestPermissionWaiver).toHaveBeenCalledTimes(1);
    expect(run.waiversRequestedCountRef.count).toBe(1);
    expect((run.ctx.eventTypes as Set<string>).has("permission_waiver_requested")).toBe(true);
  });

  it("get_notification_cadence works for default state", async () => {
    const run = await runTool("get_notification_cadence", {});
    expect(run.result).toMatchObject({
      ok: true,
      is_configured: false
    });
  });

  it("set_notification_cadence works", async () => {
    const run = await runTool("set_notification_cadence", {
      is_enabled: true,
      timezone: "America/Vancouver",
      cadence_summary: "Daily at 9am",
      cadence_json: {
        version: 1,
        schedules: [{ type: "weekly", days: [1, 2, 3, 4, 5], local_time: "09:00" }]
      }
    });
    expect(run.result).toMatchObject({ ok: true });
    expect(run.repo.upsertUserNotificationCadence).toHaveBeenCalledTimes(1);
    expect((run.ctx.eventTypes as Set<string>).has("notification_cadence_updated")).toBe(true);
  });

  it("schedule_follow_up works", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const run = await runTool("schedule_follow_up", {
      prompt: "Check if van was packed",
      schedule_at: futureIso,
      context: { task_hint: "task_1" }
    });
    expect(run.result).toMatchObject({ ok: true, schedule_at: futureIso });
    expect(run.repo.enqueueFollowUpJob).toHaveBeenCalledTimes(1);
    expect((run.ctx.eventTypes as Set<string>).has("follow_up_scheduled")).toBe(true);
  });

  it("blocks schedule_follow_up on free tier", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const run = await runTool(
      "schedule_follow_up",
      {
        prompt: "Check in tomorrow",
        schedule_at: futureIso
      },
      {
        billingPolicy: {
          planTier: "free",
          monthlyBasePriceUsd: 0,
          includedActiveUsers: 10,
          perUserOverageUsd: 0,
          includedAiCostUsd: 0,
          aiOverageMultiplier: 1,
          hardCapActiveUsers: 10,
          activeUserWindowDays: 30,
          overageEnabled: false,
          isEnabled: true
        }
      }
    );
    expect(run.result).toMatchObject({
      ok: false,
      error: "plan_limit_reached",
      reason: "schedule_follow_up_requires_paid_tier"
    });
    expect(run.repo.enqueueFollowUpJob).not.toHaveBeenCalled();
  });

  it("blocks write tools in read-only mode", async () => {
    const run = await runTool(
      "create_task",
      { title: "x", urgency: "medium", difficulty: "medium" },
      { readOnlyTools: true }
    );
    expect(run.result).toMatchObject({ ok: false, error: "permission_denied", reason: "read_only_mode" });
    expect(run.repo.save).not.toHaveBeenCalled();
  });

  it("blocks task writes when free tier active-user limit is reached for actor", async () => {
    const billingDb = makeBillingCapDbStub({
      activeExternalUserIds: [],
      activeUsersCount: 10
    });
    const run = await runTool(
      "create_task",
      { title: "Blocked task", urgency: "medium", difficulty: "medium" },
      {
        env: { DB: billingDb, AGENT_TOOL_READ_LIMIT: "100" }
      }
    );
    expect(run.result).toMatchObject({
      ok: false,
      error: "free_tier_active_user_limit_reached"
    });
    expect(run.repo.save).not.toHaveBeenCalled();
  });

  it("blocks task writes when free tier monthly AI cap is exceeded", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const all = vi.fn(async () => ({ results: [] }));
    const billingDb = {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => ({
          run,
          all,
          first: vi.fn(async () => {
            if (sql.includes("effective_plan_tier")) {
              return {
                effective_plan_tier: "free",
                included_active_users: 10,
                hard_cap_active_users: 10,
                active_user_window_days: 30,
                overage_enabled: 0,
                is_enabled: 1
              };
            }
            if (sql.includes("month_cost_usd")) {
              return { month_cost_usd: 12.5 };
            }
            if (sql.includes("FROM workspace_user_activity") && sql.includes("external_user_id = ?")) {
              const externalUserId = String(args[2] ?? "");
              if (externalUserId === "U0B2T03RPD0") {
                return { id: "activity_actor" };
              }
              return null;
            }
            if (sql.includes("COUNT(*) AS active_users")) {
              return { active_users: 1 };
            }
            return null;
          })
        })
      }))
    };

    const blocked = await runTool(
      "create_task",
      { title: "Blocked by spend", urgency: "medium", difficulty: "medium" },
      {
        env: { DB: billingDb as unknown as D1Database, AGENT_TOOL_READ_LIMIT: "100", FREE_TIER_MONTHLY_AI_CAP_USD: "10" }
      }
    );
    expect(blocked.result).toMatchObject({
      ok: false,
      error: "free_tier_ai_spend_limit_reached"
    });
    expect(blocked.repo.save).not.toHaveBeenCalled();
  });

  it("creates for allowed assignees and skips blocked assignees on free tier", async () => {
    const billingDb = makeBillingCapDbStub({
      activeExternalUserIds: ["U0B2T03RPD0"],
      activeUsersCount: 10
    });
    const run = await runTool(
      "create_task",
      {
        title: "Split assignee task",
        urgency: "medium",
        difficulty: "medium",
        assignee_user_ids: ["U0B2T03RPD0", "U_NEW_OVER_CAP"]
      },
      {
        env: { DB: billingDb, AGENT_TOOL_READ_LIMIT: "100" }
      }
    );
    expect(run.result).toMatchObject({
      ok: true,
      skipped_assignees: [{ assignee_user_id: "U_NEW_OVER_CAP", reason: "free_tier_active_user_limit_reached" }]
    });
    const taskIds = (run.result as Record<string, unknown>).task_ids as string[];
    expect(taskIds).toHaveLength(1);
    expect(run.repo.save).toHaveBeenCalledTimes(1);
  });
});
