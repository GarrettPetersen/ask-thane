import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLlmClient } from "../src/index";

const baseEvent = {
  workspaceId: "T1",
  channelId: "C1",
  messageId: "1710000000.000001",
  text: "Please handle this with <@U0B2QTLPABY>",
  author: {
    platform: "slack" as const,
    platformUserId: "U_GARRETT"
  },
  occurredAt: "2026-05-14T20:00:00.000Z"
};

describe("@ask-thane/ai", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns stub response for non-openai providers", async () => {
    const client = createLlmClient({ provider: "anthropic", model: "x" });
    const result = await client.extractTasksFromConversation(baseEvent);
    expect(result.tasks).toEqual([]);
    expect(result.reasoningSummary).toContain("stub_anthropic:x");
  });

  it("returns missing-key summary when openai key is absent", async () => {
    const client = createLlmClient({ provider: "openai", model: "gpt-test" });
    const result = await client.extractTasksFromConversation(baseEvent);
    expect(result.tasks).toEqual([]);
    expect(result.reasoningSummary).toBe("openai_api_key_missing");
  });

  it("returns failure summary when OpenAI request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: "rate_limit_exceeded" } })
      }))
    );

    const client = createLlmClient({ provider: "openai", model: "gpt-test", openAiApiKey: "k" });
    const result = await client.extractTasksFromConversation(baseEvent);
    expect(result.tasks).toEqual([]);
    expect(result.reasoningSummary).toBe("openai_request_failed:rate_limit_exceeded");
  });

  it("normalizes extracted tasks from valid OpenAI json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reasoning_summary: "ok",
                  tasks: [
                    {
                      title: "  Pack van  ",
                      description: "  bring snacks  ",
                      assignee_user_id: null,
                      assignee_name: "  Danika  ",
                      urgency: "critical",
                      difficulty: "high",
                      status: "in_progress",
                      confidence: 2,
                      due_at: "2026-05-15T10:00:00-07:00"
                    },
                    {
                      title: "Backup task",
                      assignee_user_id: "",
                      urgency: "not-valid",
                      difficulty: "not-valid",
                      status: "not-valid",
                      confidence: Number.NaN,
                      due_at: "not-a-date"
                    }
                  ]
                })
              }
            }
          ]
        })
      }))
    );

    const client = createLlmClient({ provider: "openai", model: "gpt-test", openAiApiKey: "k" });
    const result = await client.extractTasksFromConversation(baseEvent);

    expect(result.reasoningSummary).toBe("ok");
    expect(result.tasks).toHaveLength(2);

    const first = result.tasks[0];
    expect(first?.title).toBe("Pack van");
    expect(first?.assignee.platformUserId).toBe("U0B2QTLPABY");
    expect(first?.assignee.displayName).toBe("Danika");
    expect(first?.description).toBe("bring snacks");
    expect(first?.urgency).toBe("critical");
    expect(first?.difficulty).toBe("high");
    expect(first?.status).toBe("in_progress");
    expect(first?.confidence).toBe(1);
    expect(first?.dueAt).toBe("2026-05-15T17:00:00.000Z");

    const second = result.tasks[1];
    expect(second?.assignee.platformUserId).toBe("U0B2QTLPABY");
    expect(second?.urgency).toBe("medium");
    expect(second?.difficulty).toBe("medium");
    expect(second?.status).toBe("incomplete");
    expect(second?.confidence).toBe(0.55);
    expect(second?.dueAt).toBeUndefined();
  });
});
