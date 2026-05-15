import { describe, expect, it, vi } from "vitest";
import { ingestMessageForTasks } from "../src/index";

const event = {
  workspaceId: "ws_1",
  channelId: "C1",
  messageId: "m1",
  text: "Pack the van",
  author: {
    platform: "slack" as const,
    platformUserId: "U_GARRETT"
  },
  occurredAt: "2026-05-14T20:00:00.000Z"
};

describe("@ask-thane/workflows", () => {
  it("fills defaults and persists extracted tasks", async () => {
    const llm = {
      extractTasksFromConversation: vi.fn(async () => ({
        reasoningSummary: "ok",
        tasks: [
          {
            id: "",
            workspaceId: "",
            channelId: "",
            sourceMessageId: "",
            title: "Pack van",
            assignee: { platform: "slack", platformUserId: "U_GARRETT" as const },
            assigner: undefined,
            createdAt: "",
            urgency: undefined,
            difficulty: undefined,
            status: undefined,
            confidence: Number.NaN
          }
        ]
      }))
    };
    const tasks = {
      saveMany: vi.fn(async () => {})
    };

    const result = await ingestMessageForTasks(event, {
      llm: llm as never,
      tasks: tasks as never
    });

    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first?.workspaceId).toBe("ws_1");
    expect(first?.channelId).toBe("C1");
    expect(first?.sourceMessageId).toBe("m1");
    expect(first?.assigner.platformUserId).toBe("U_GARRETT");
    expect(first?.status).toBe("incomplete");
    expect(first?.urgency).toBe("medium");
    expect(first?.difficulty).toBe("medium");
    expect(first?.confidence).toBe(0.5);
    expect(tasks.saveMany).toHaveBeenCalledTimes(1);
  });

  it("does not write when no tasks are extracted", async () => {
    const llm = {
      extractTasksFromConversation: vi.fn(async () => ({
        reasoningSummary: "none",
        tasks: []
      }))
    };
    const tasks = {
      saveMany: vi.fn(async () => {})
    };

    const result = await ingestMessageForTasks(event, {
      llm: llm as never,
      tasks: tasks as never
    });

    expect(result).toEqual([]);
    expect(tasks.saveMany).not.toHaveBeenCalled();
  });
});
