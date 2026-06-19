import type { MessageEvent, TaskDifficulty, TaskExtractionResult, TaskRecord, TaskStatus, TaskUrgency } from "@ask-thane/domain";

export interface LlmClient {
  extractTasksFromConversation(event: MessageEvent): Promise<TaskExtractionResult>;
}

export interface LlmClientOptions {
  provider: "openai" | "anthropic";
  model: string;
  openAiApiKey?: string;
  anthropicApiKey?: string;
}

interface ExtractedTaskShape {
  title: string;
  description?: string | null;
  assignee_user_id?: string | null;
  assignee_name?: string | null;
  urgency?: TaskUrgency | null;
  difficulty?: TaskDifficulty | null;
  status?: TaskStatus | null;
  confidence?: number | null;
  due_at?: string | null;
}

interface OpenAiChatCompletion {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
}

function firstMention(event: MessageEvent): string | null {
  const slackMatch = event.text.match(/<@([A-Z0-9]+)>/);
  if (slackMatch?.[1]) {
    return slackMatch[1];
  }
  if (event.author.platform === "thane_cli") {
    const thaneMatch = event.text.match(/@([a-zA-Z0-9._-]+)/);
    if (thaneMatch?.[1] && thaneMatch[1].toLowerCase() !== "thane") {
      return thaneMatch[1].toLowerCase();
    }
  }
  return null;
}

function sanitizeStatus(value: string | null | undefined): TaskStatus {
  if (value === "incomplete" || value === "in_progress" || value === "blocked" || value === "done" || value === "cancelled") {
    return value;
  }
  return "incomplete";
}

function sanitizeUrgency(value: string | null | undefined): TaskUrgency {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
}

function sanitizeDifficulty(value: string | null | undefined): TaskDifficulty {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function sanitizeConfidence(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return 0.55;
  }
  return Math.min(1, Math.max(0, Number(value)));
}

function normalizeDueAt(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return undefined;
  }
  return parsed.toISOString();
}

function pickAssigneeId(candidate: string | null | undefined, fallback: string): string {
  const trimmed = candidate?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function buildSystemPrompt(): string {
  return [
    "You extract actionable tasks from chat messages.",
    "Only extract tasks when a concrete request, assignment, or commitment is present.",
    "If there is no clear task, return an empty tasks array.",
    "If text is an instruction to Thane about changing an existing task (for example add details/update metadata), do not output a new task.",
    "Task title must be concise and action-only; do not include assignee phrases such as 'with Danika' in title.",
    "Use description for collaborator/context details and constraints.",
    "Prefer assignee_user_id from mentions. Slack mentions look like <@U123>; Thane Chat mentions look like @handle. If unclear, leave assignee_user_id null.",
    "Output must match the provided JSON schema exactly."
  ].join(" ");
}

function buildUserPrompt(event: MessageEvent): string {
  return [
    `workspace_id: ${event.workspaceId}`,
    `channel_id: ${event.channelId}`,
    `message_id: ${event.messageId}`,
    `author_platform_user_id: ${event.author.platformUserId}`,
    `timestamp_iso: ${event.occurredAt}`,
    "message_text:",
    event.text
  ].join("\n");
}

class OpenAiLlmClient implements LlmClient {
  constructor(private readonly options: LlmClientOptions) {}

  async extractTasksFromConversation(event: MessageEvent): Promise<TaskExtractionResult> {
    if (!this.options.openAiApiKey) {
      return {
        tasks: [],
        reasoningSummary: "openai_api_key_missing"
      };
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt()
          },
          {
            role: "user",
            content: buildUserPrompt(event)
          }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "task_extraction_result",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["reasoning_summary", "tasks"],
              properties: {
                reasoning_summary: {
                  type: "string"
                },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "assignee_user_id", "urgency", "difficulty", "status", "confidence"],
                    properties: {
                      title: { type: "string" },
                      description: { type: ["string", "null"] },
                      assignee_user_id: { type: ["string", "null"] },
                      assignee_name: { type: ["string", "null"] },
                      urgency: { type: "string", enum: ["low", "medium", "high", "critical"] },
                      difficulty: { type: "string", enum: ["low", "medium", "high"] },
                      status: {
                        type: "string",
                        enum: ["incomplete", "in_progress", "blocked", "done", "cancelled"]
                      },
                      confidence: { type: "number" },
                      due_at: { type: ["string", "null"] }
                    }
                  }
                }
              }
            }
          }
        }
      })
    });

    const payload = (await response.json()) as OpenAiChatCompletion;
    if (!response.ok) {
      const code = payload.error?.code ?? payload.error?.type ?? String(response.status);
      return {
        tasks: [],
        reasoningSummary: `openai_request_failed:${code}`
      };
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return {
        tasks: [],
        reasoningSummary: "openai_empty_response"
      };
    }

    let parsed: {
      reasoning_summary?: string;
      tasks?: ExtractedTaskShape[];
    } | null = null;

    try {
      parsed = JSON.parse(content) as {
        reasoning_summary?: string;
        tasks?: ExtractedTaskShape[];
      };
    } catch {
      return {
        tasks: [],
        reasoningSummary: "openai_invalid_json"
      };
    }

    const fallbackAssignee = firstMention(event) ?? event.author.platformUserId;
    const tasks: TaskRecord[] = (parsed.tasks ?? [])
      .filter((task) => typeof task.title === "string" && task.title.trim().length > 0)
      .map((task) => {
        const assignee: TaskRecord["assignee"] = {
          platform: event.author.platform,
          platformUserId: pickAssigneeId(task.assignee_user_id, fallbackAssignee)
        };
        const assigneeName = task.assignee_name?.trim();
        if (assigneeName) {
          assignee.displayName = assigneeName;
        }

        const mapped: TaskRecord = {
          id: crypto.randomUUID(),
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          sourceMessageId: event.messageId,
          title: task.title.trim(),
          assignee,
          assigner: event.author,
          createdAt: new Date().toISOString(),
          urgency: sanitizeUrgency(task.urgency),
          difficulty: sanitizeDifficulty(task.difficulty),
          status: sanitizeStatus(task.status),
          confidence: sanitizeConfidence(task.confidence),
          metadata: {
            extractor: "openai_chat_completions_json_schema",
            model: this.options.model
          }
        };

        const description = task.description?.trim();
        if (description) {
          mapped.description = description;
        }

        const dueAt = normalizeDueAt(task.due_at);
        if (dueAt) {
          mapped.dueAt = dueAt;
        }

        return mapped;
      });

    return {
      tasks,
      reasoningSummary: parsed.reasoning_summary ?? `openai:${this.options.model}:ok`
    };
  }
}

class StubLlmClient implements LlmClient {
  constructor(private readonly options: LlmClientOptions) {}

  async extractTasksFromConversation(event: MessageEvent): Promise<TaskExtractionResult> {
    return {
      tasks: [],
      reasoningSummary: `stub_${this.options.provider}:${this.options.model}:${event.messageId}`
    };
  }
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  if (options.provider === "openai") {
    return new OpenAiLlmClient(options);
  }

  return new StubLlmClient(options);
}
