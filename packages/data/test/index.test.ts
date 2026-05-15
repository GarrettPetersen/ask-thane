import { describe, expect, it } from "vitest";
import { D1TaskRepository } from "../src/index";

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1",
    workspace_id: "ws_1",
    primary_conversation_source_id: null,
    channel_id: "C1",
    source_message_id: "m1",
    title: "Pack van",
    description: "details",
    assignee_platform: "slack",
    assignee_id: "U1",
    assignee_name: "Garrett",
    assigner_platform: "slack",
    assigner_id: "U2",
    assigner_name: "Danika",
    created_at: "2026-05-14T20:00:00.000Z",
    due_at: null,
    urgency: "medium",
    difficulty: "medium",
    status: "incomplete",
    effective_status: "incomplete",
    confidence: 0.8,
    metadata_json: "{}",
    ...overrides
  };
}

describe("@ask-thane/data", () => {
  it("records ingest event metadata fields", async () => {
    const bindCalls: unknown[][] = [];
    const db = {
      prepare: (_sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            bindCalls.push(args);
            return { meta: { changes: 1 } };
          }
        })
      })
    };

    const repo = new D1TaskRepository(db as never);
    const created = await repo.recordIngestEvent({
      id: "ingest_1",
      organizationId: "org_0",
      provider: "slack",
      providerEventId: "Ev123",
      providerMessageId: "1778782201.060409",
      conversationSourceId: "conv_1",
      eventType: "member_joined_channel",
      eventSubtype: "channel_join",
      channelId: "C123",
      actorExternalUserId: "U123",
      eventTs: "1778782201.060409",
      receivedAt: "2026-05-14T18:10:02.163Z"
    });

    expect(created).toBe(true);
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0]).toEqual([
      "ingest_1",
      "org_0",
      "slack",
      "Ev123",
      "1778782201.060409",
      "conv_1",
      "member_joined_channel",
      "channel_join",
      "C123",
      "U123",
      "1778782201.060409",
      "2026-05-14T18:10:02.163Z"
    ]);
  });

  it("retries task search without query when D1 LIKE pattern is too complex", async () => {
    let callCount = 0;
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            callCount += 1;
            if (sql.includes("LOWER(vt.title) LIKE")) {
              throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
            }
            return { results: [makeTaskRow()] };
          }
        })
      })
    };

    const repo = new D1TaskRepository(db as never);
    const tasks = await repo.searchTasksWithAcl({
      organizationId: "org_0",
      readableConversationSourceIds: ["conv_1"],
      allowUnscoped: true,
      query: "add details to van packing",
      limit: 10
    });

    expect(callCount).toBe(2);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Pack van");
  });

  it("retries workspace user search without query on D1 LIKE pattern error", async () => {
    let callCount = 0;
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            callCount += 1;
            if (sql.includes("LOWER(COALESCE(display_name")) {
              throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
            }
            return {
              results: [
                {
                  id: "user_1",
                  external_user_id: "U1",
                  display_name: "Garrett",
                  email: "garrett@example.com"
                }
              ]
            };
          }
        })
      })
    };

    const repo = new D1TaskRepository(db as never);
    const people = await repo.listWorkspaceUsers({
      organizationId: "org_0",
      workspaceId: "ws_1",
      query: "garrett % _",
      limit: 20
    });

    expect(callCount).toBe(2);
    expect(people).toEqual([
      {
        userId: "user_1",
        externalUserId: "U1",
        displayName: "Garrett",
        email: "garrett@example.com"
      }
    ]);
  });

  it("updates assignee fields when edit task action includes assignee data", async () => {
    const updateBinds: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes("SELECT id, status, primary_conversation_source_id")) {
              return {
                id: "task_1",
                status: "incomplete",
                primary_conversation_source_id: null
              };
            }
            return null;
          },
          run: async () => {
            if (sql.includes("UPDATE tasks")) {
              updateBinds.push(args);
            }
            return { meta: { changes: 1 } };
          },
          all: async () => ({ results: [] })
        })
      })
    };

    const repo = new D1TaskRepository(db as never);
    await repo.performTaskAction({
      id: "action_1",
      organizationId: "org_0",
      workspaceId: "ws_1",
      taskId: "task_1",
      actionType: "edit",
      actorPlatform: "slack",
      actorId: "U_GARRETT",
      sourceConversationSourceId: "conv_1",
      assigneePlatform: "slack",
      assigneeId: "U_DANIKA",
      assigneeName: "Danika",
      payload: {},
      createdAt: "2026-05-14T20:00:00.000Z"
    });

    expect(updateBinds).toHaveLength(1);
    const bind = updateBinds[0] ?? [];
    expect(bind[6]).toBe(1);
    expect(bind[7]).toBe("slack");
    expect(bind[8]).toBe(1);
    expect(bind[9]).toBe("U_DANIKA");
    expect(bind[10]).toBe(1);
    expect(bind[11]).toBe("Danika");
  });
});
