import { D1TaskRepository, type AclTaskSearchInput } from "@ask-thane/data";
import type {
  NoteScopeType,
  NoteVisibility,
  TaskActionType,
  TaskDifficulty,
  TaskRecord,
  TaskStatus,
  TaskUrgency
} from "@ask-thane/domain";
import type { MessageEvent } from "@ask-thane/domain";
import { ConversationAccessResolver } from "./conversation-access";
import { computeNextDigestAt, defaultCadenceSpec, normalizeCadenceSpec, normalizeTimezone } from "./notification-cadence";
import { fetchSlackConversationHistory, type SlackHistoryMessage } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface AgentRuntimeInput {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  conversationSourceId: string;
  event: MessageEvent;
  interactionMode?: "passive_ingest" | "dm_reply" | "proactive_followup";
  readOnlyTools?: boolean;
}

interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ChatCompletionToolCall[];
    };
  }>;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface AgentRunResult {
  usedTools: boolean;
  createdTaskIds: string[];
  updatedTaskIds: string[];
  taskActionTypes: TaskActionType[];
  finalSummary?: string;
  replyText?: string;
}

interface ToolContext {
  env: BotEnv;
  repo: D1TaskRepository;
  resolver: ConversationAccessResolver;
  installStore: SlackInstallStore;
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  actorExternalUserId: string;
  actorInternalUserId: string;
  actorPersonId?: string;
  readableConversationSourceIds: string[];
  currentConversationSourceId: string;
  botToken: string;
  createdTaskIds: string[];
  taskActionTypes: Set<TaskActionType>;
  recentMessages: SlackHistoryMessage[];
  event: MessageEvent;
  interactionMode: "passive_ingest" | "dm_reply" | "proactive_followup";
  readOnlyTools: boolean;
  botExternalUserId?: string;
  workspaceUsers: Array<{ userId: string; externalUserId: string; displayName?: string; email?: string }>;
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

function asTaskStatusList(raw: unknown): TaskStatus[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed: TaskStatus[] = ["incomplete", "in_progress", "blocked", "done", "cancelled"];
  const statuses = raw.filter((value): value is TaskStatus => typeof value === "string" && allowed.includes(value as TaskStatus));
  return statuses.length > 0 ? statuses : undefined;
}

function asNoteScopeType(raw: unknown): NoteScopeType | null {
  if (
    raw === "organization" ||
    raw === "workspace" ||
    raw === "conversation" ||
    raw === "person" ||
    raw === "user" ||
    raw === "task"
  ) {
    return raw;
  }
  return null;
}

function asVisibility(raw: unknown): NoteVisibility | null {
  if (raw === "private" || raw === "organization" || raw === "conversation_acl") {
    return raw;
  }
  return null;
}

function asTaskActionType(raw: unknown): TaskActionType | null {
  if (
    raw === "create" ||
    raw === "mark_done" ||
    raw === "mark_cancelled" ||
    raw === "mark_blocked" ||
    raw === "reopen" ||
    raw === "merge_into" ||
    raw === "edit"
  ) {
    return raw;
  }
  return null;
}

function asUrgency(raw: unknown): TaskUrgency {
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") {
    return raw;
  }
  return "medium";
}

function asDifficulty(raw: unknown): TaskDifficulty {
  if (raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return "medium";
}

function summarizeTask(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee_user_id: task.assignee.platformUserId,
    assigner_user_id: task.assigner.platformUserId,
    urgency: task.urgency,
    difficulty: task.difficulty,
    created_at: task.createdAt,
    due_at: task.dueAt ?? null,
    channel_id: task.channelId ?? null,
    source_message_id: task.sourceMessageId ?? null
  };
}

function toolDefinitions(mode: "passive_ingest" | "dm_reply" | "proactive_followup") {
  const tools = [
    {
      type: "function",
      function: {
        name: "search_tasks",
        description:
          "Search visible tasks in the organization with ACL already enforced. assignee_user_id accepts Slack external_user_id and workspace user_id.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            assignee_user_id: { type: "string" },
            statuses: {
              type: "array",
              items: {
                type: "string",
                enum: ["incomplete", "in_progress", "blocked", "done", "cancelled"]
              }
            },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_notes",
        description: "Read previously stored agent notes from a specific scope.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["scope_type", "scope_id"],
          properties: {
            scope_type: {
              type: "string",
              enum: ["organization", "workspace", "conversation", "person", "user", "task"]
            },
            scope_id: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_note",
        description: "Write an agent memory note scoped to org/workspace/conversation/person/user/task.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["scope_type", "scope_id", "visibility", "content"],
          properties: {
            scope_type: {
              type: "string",
              enum: ["organization", "workspace", "conversation", "person", "user", "task"]
            },
            scope_id: { type: "string" },
            visibility: {
              type: "string",
              enum: ["private", "organization", "conversation_acl"]
            },
            content: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_conversation_context",
        description: "Read recent messages from a readable conversation.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            conversation_source_id: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_readable_conversations",
        description: "List readable conversations in this workspace, optionally filtered by type or text query.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            conversation_kind: {
              type: "string",
              enum: ["public_channel", "private_channel", "group_dm", "dm"]
            },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_task_timeline",
        description: "Read visible task action history for a task.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["task_id"],
          properties: {
            task_id: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_workspace_people",
        description:
          "Search people/users in this workspace by name/email/user id. Use external_user_id for task assignee filters and assignment.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_task",
        description: "Create a new task from conversational intent.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            assignee_user_id: { type: "string" },
            urgency: { type: "string", enum: ["low", "medium", "high", "critical"] },
            difficulty: { type: "string", enum: ["low", "medium", "high"] },
            due_at: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_task",
        description: "Apply a task action to an existing task when state changed from conversation.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["task_id", "action_type"],
          properties: {
            task_id: { type: "string" },
            action_type: {
              type: "string",
              enum: ["mark_done", "mark_cancelled", "mark_blocked", "reopen", "merge_into", "edit"]
            },
            status: {
              type: "string",
              enum: ["incomplete", "in_progress", "blocked", "done", "cancelled"]
            },
            title: { type: "string" },
            description: { type: "string" },
            due_at: { type: "string" },
            target_task_id: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "request_permission_waiver",
        description: "Record a permission waiver request for widening visibility.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["resource_type", "resource_id", "requested_scope_type", "requested_scope_id"],
          properties: {
            resource_type: { type: "string" },
            resource_id: { type: "string" },
            requested_scope_type: {
              type: "string",
              enum: ["organization", "workspace", "conversation", "person", "user", "task"]
            },
            requested_scope_id: { type: "string" },
            reason: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "record_feedback",
        description:
          "Record a user correction or quality signal about task tracking (for example not-a-task, wrong-assignee, wrong-status).",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["feedback_type"],
          properties: {
            feedback_type: {
              type: "string",
              enum: ["not_a_task", "wrong_assignee", "wrong_status", "wrong_priority", "other"]
            },
            task_id: { type: "string" },
            note: { type: "string" },
            details: { type: "object" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_notification_cadence",
        description: "Read the actor user's current reminder cadence for task digests.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "set_notification_cadence",
        description:
          "Set or update the actor user's reminder cadence and timezone when they ask for a different schedule.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            is_enabled: { type: "boolean" },
            timezone: { type: "string" },
            cadence_summary: { type: "string" },
            cadence_json: { type: "object" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "schedule_follow_up",
        description:
          "Schedule a proactive follow-up DM to the actor user at a future time so Thane can check back asynchronously.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "schedule_at"],
          properties: {
            prompt: { type: "string" },
            schedule_at: { type: "string" },
            context: { type: "object" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "finalize_user_reply",
        description:
          "Finalize the exact user-facing reply text. Use this as the last step after reasoning/tool usage so only this message is sent to the user.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["reply_text"],
          properties: {
            reply_text: { type: "string" }
          }
        }
      }
    }
  ] as const;

  if (mode === "passive_ingest") {
    return tools.filter((tool) => tool.function.name !== "finalize_user_reply");
  }

  if (mode === "proactive_followup") {
    return tools.filter(
      (tool) =>
        tool.function.name !== "create_task" &&
        tool.function.name !== "update_task" &&
        tool.function.name !== "record_feedback" &&
        tool.function.name !== "write_note" &&
        tool.function.name !== "request_permission_waiver" &&
        tool.function.name !== "set_notification_cadence" &&
        tool.function.name !== "schedule_follow_up"
    );
  }

  return tools;
}

function systemPrompt(mode: "passive_ingest" | "dm_reply" | "proactive_followup"): string {
  const responseInstruction =
    mode === "dm_reply"
      ? "Respond conversationally to the user in plain text. Keep it concise, helpful, and action-oriented. Reason privately, then always call finalize_user_reply with only the final user-facing message."
      : mode === "proactive_followup"
        ? "Compose a useful proactive follow-up message in plain text using available task context. Reason privately, then always call finalize_user_reply with only the final user-facing message."
      : "Final response must be short JSON with keys: summary, created_task_ids, updated_task_ids, notes_written, waivers_requested.";

  return [
    "You are Thane, an autonomous conversational task-tracking agent.",
    "You may call tools multiple times to read context, search tasks, read/write notes, and mutate task state.",
    "Only use data accessible by tool outputs; never assume hidden context.",
    "When task relevance or implied intent is ambiguous, use read tools first (search_tasks, get_notes, search_workspace_people, search_readable_conversations, get_conversation_context) to ground your decision.",
    "Treat reactions, mentions, and historical notes as signals, not certainty.",
    "Infer the organization's operating context (business domain, team norms, channel purpose) from notes, participant patterns, prior tasks, and recent conversation context before deciding what is task-worthy.",
    "Track tasks that are relevant to this organization's context; avoid tracking personal errands/chatter that are clearly out-of-scope for the org.",
    "Examples: in a household-oriented workspace, 'get groceries' may be a valid task; in a work-oriented workspace, casual personal groceries chatter is usually not a tracked task.",
    "A single message may contain multiple independent task events; detect each event and apply all needed tool calls in the same run.",
    "For statements that imply progress/completion/cancellation/blocking, always search existing tasks first and update matching tasks instead of creating duplicates.",
    "For each clause: (1) classify clause intent, (2) if it references existing work then update_task, (3) if it introduces new work then create_task.",
    "Some statements imply urgent work even without imperative wording; when context indicates operational impact, infer and track the implied task.",
    "Examples: 'the website is down' in a web business context implies an incident task to restore service (and possibly investigation/fix follow-up).",
    "Counter-example: 'I need to pick up my kids' in a work channel is usually context/explanation, not a trackable org task.",
    "If one clause closes or changes an existing task and another clause introduces remaining or new work, emit both update_task and create_task actions.",
    "If someone reports completed work and no matching task exists, you may create a historical task and immediately mark it done so completion is tracked.",
    "When users correct Thane (for example not-a-task, wrong assignee, wrong status), record this feedback with record_feedback and then make corrective task updates when possible.",
    "Examples: 'I am done the dishes, but I still need to water the gnomes' => mark_done(dishes) + create_task(water gnomes) if missing.",
    "Examples: 'I'm done watering the gnomes, but I still need to elevate the cake and bloviate the sneed' => mark_done(water gnomes) + create_task(elevate cake) + create_task(bloviate sneed).",
    "Examples: 'I froze the beef last night' should update existing freeze-beef task to done when a matching open task exists.",
    "Examples: if someone says they finished work and no task exists, create_task(that work) + update_task(mark_done) in the same run.",
    "When assignee is not explicit, treat first-person commitments as self-assigned by default.",
    "When the task is a delegation to someone else, set assignee_user_id explicitly after using workspace people/context tools.",
    "Interpret deictic second-person address using conversation context: when the speaker addresses another participant (for example 'you' in a shared channel), do not assign to the speaker unless context explicitly indicates self-assignment.",
    "Use person-level notes and ownership patterns for disambiguation when deciding assignees in ambiguous requests.",
    "You may write person notes for other workspace participants when the message contains durable facts about them.",
    "For names and nicknames, resolve candidates with workspace people search and context instead of rigid phrase rules.",
    "Ignore non-task chatter such as weather commentary unless it changes a task state.",
    "If task completion/cancellation is asserted in private context and visibility is unclear, create a permission waiver request.",
    "When writing notes, prefer short durable facts (skills, ownership patterns, constraints).",
    "Avoid duplicate tasks for same intent/source message.",
    "Use notification cadence tools when the user asks to change reminder frequency or timing.",
    mode === "proactive_followup"
      ? "In proactive_followup mode, do not request permission waivers or mutate tasks; focus on clarity and next actions."
      : "",
    responseInstruction
  ]
    .filter((line) => line.length > 0)
    .join(" ");
}

async function resolveSlackInstall(input: {
  env: BotEnv;
  installStore: SlackInstallStore;
  externalWorkspaceId: string;
}): Promise<{ botToken: string | null; botUserId?: string }> {
  const installed = await input.installStore.getInstallByExternalWorkspaceId(input.externalWorkspaceId);
  if (installed?.botToken) {
    return {
      botToken: installed.botToken,
      ...(installed.botUserId ? { botUserId: installed.botUserId } : {})
    };
  }
  return { botToken: input.env.SLACK_BOT_TOKEN ?? null };
}

function isSlackAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("invalid_auth") || message.includes("not_authed");
}

function permissionError(tool: string, reason: string): Record<string, unknown> {
  return { ok: false, tool, error: "permission_denied", reason };
}

function clampEnvNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function extractSlackMentionIds(text: string): string[] {
  const mentions = new Set<string>();
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let match: RegExpExecArray | null = null;
  while ((match = mentionRegex.exec(text))) {
    if (match[1]) {
      mentions.add(match[1]);
    }
  }
  return Array.from(mentions);
}

function looksLikeSlackExternalUserId(value: string): boolean {
  return /^U[A-Z0-9]+$/.test(value) || value === "USLACKBOT";
}

function resolveExternalUserIdFromWorkspaceDirectory(
  rawIdentifier: string,
  workspaceUsers: Array<{ userId: string; externalUserId: string; displayName?: string; email?: string }>
): string | null {
  const trimmed = rawIdentifier.trim();
  if (!trimmed) {
    return null;
  }
  if (looksLikeSlackExternalUserId(trimmed)) {
    return trimmed;
  }

  const byInternal = workspaceUsers.find((user) => user.userId === trimmed);
  if (byInternal) {
    return byInternal.externalUserId;
  }

  const normalized = trimmed.toLowerCase();
  const byExternal = workspaceUsers.find((user) => user.externalUserId.toLowerCase() === normalized);
  if (byExternal) {
    return byExternal.externalUserId;
  }

  const byDisplayName = workspaceUsers.find((user) => user.displayName?.trim().toLowerCase() === normalized);
  if (byDisplayName) {
    return byDisplayName.externalUserId;
  }

  const byEmail = workspaceUsers.find((user) => user.email?.trim().toLowerCase() === normalized);
  if (byEmail) {
    return byEmail.externalUserId;
  }

  return null;
}

async function resolveAssigneeExternalUserId(input: {
  requested: string;
  ctx: ToolContext;
  allowWorkspaceLookupFallback: boolean;
}): Promise<{
  resolvedExternalUserId: string;
  source: "directory" | "workspace_lookup" | "raw_unresolved";
}> {
  const trimmed = input.requested.trim();
  const fromDirectory = resolveExternalUserIdFromWorkspaceDirectory(trimmed, input.ctx.workspaceUsers);
  if (fromDirectory) {
    return { resolvedExternalUserId: fromDirectory, source: "directory" };
  }

  if (input.allowWorkspaceLookupFallback) {
    const people = await input.ctx.repo.listWorkspaceUsers({
      organizationId: input.ctx.organizationId,
      workspaceId: input.ctx.workspaceId,
      query: trimmed,
      limit: 15
    });
    if (people.length === 1) {
      const only = people[0];
      if (only) {
        return { resolvedExternalUserId: only.externalUserId, source: "workspace_lookup" };
      }
    }

    const normalized = trimmed.toLowerCase();
    const exact = people.find((person) => {
      const displayName = person.displayName?.trim().toLowerCase();
      const email = person.email?.trim().toLowerCase();
      return (
        person.externalUserId.toLowerCase() === normalized ||
        person.userId.toLowerCase() === normalized ||
        displayName === normalized ||
        email === normalized
      );
    });
    if (exact) {
      return { resolvedExternalUserId: exact.externalUserId, source: "workspace_lookup" };
    }
  }

  return { resolvedExternalUserId: trimmed, source: "raw_unresolved" };
}

async function inferAssigneeFromConversationContext(ctx: ToolContext): Promise<string> {
  const explicitMentions = extractSlackMentionIds(ctx.event.text).filter(
    (id) => id !== ctx.actorExternalUserId && (!ctx.botExternalUserId || id !== ctx.botExternalUserId)
  );
  if (explicitMentions.length > 0) {
    return explicitMentions[0] ?? ctx.actorExternalUserId;
  }

  // Conservative fallback: if assignee wasn't explicit, default to actor.
  // Delegations should be set explicitly by the model via assignee_user_id.
  return ctx.actorExternalUserId;
}

function parseIsoTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date.toISOString();
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callChatCompletionWithRetry(input: {
  env: BotEnv;
  body: Record<string, unknown>;
}): Promise<ChatCompletionResponse> {
  const retries = clampEnvNumber(input.env.AGENT_COMPLETION_RETRIES, 2, 0, 5);
  const timeoutMs = clampEnvNumber(input.env.AGENT_COMPLETION_TIMEOUT_MS, 45000, 5000, 120000);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(timeoutMs)
      });

      const payload = (await response.json()) as ChatCompletionResponse;
      if (response.ok) {
        return payload;
      }

      const retryable = response.status === 429 || response.status >= 500;
      const code = payload.error?.code ?? payload.error?.type ?? String(response.status);
      if (!retryable || attempt === retries) {
        throw new Error(`agent_completion_failed:${code}`);
      }

      await sleepMs(250 * (attempt + 1));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === retries) {
        break;
      }
      await sleepMs(250 * (attempt + 1));
    }
  }

  throw lastError ?? new Error("agent_completion_failed:unknown");
}

async function recordLlmUsageEvent(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  conversationSourceId: string;
  sourceMessageId: string;
  model: string;
  interactionMode: "passive_ingest" | "dm_reply" | "proactive_followup";
  payload: ChatCompletionResponse;
}): Promise<void> {
  const usage = input.payload.usage;
  if (!usage) {
    return;
  }

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);

  await input.env.DB
    .prepare(
      `INSERT INTO llm_usage_events (
         id, organization_id, workspace_id, provider, model, prompt_tokens, completion_tokens,
         total_tokens, request_type, source, source_message_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      input.organizationId,
      input.workspaceId,
      "openai",
      input.model,
      promptTokens,
      completionTokens,
      totalTokens,
      input.interactionMode,
      input.conversationSourceId,
      input.sourceMessageId,
      new Date().toISOString()
    )
    .run();
}

async function executeTool(
  toolCall: ChatCompletionToolCall,
  ctx: ToolContext,
  updatedTaskIds: Set<string>,
  notesWrittenCountRef: { count: number },
  waiversRequestedCountRef: { count: number },
  finalReplyRef: { text?: string; finalized: boolean }
): Promise<Record<string, unknown>> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid_tool_arguments_json" };
  }

  const writeTools = new Set([
    "record_feedback",
    "write_note",
    "create_task",
    "update_task",
    "request_permission_waiver",
    "set_notification_cadence",
    "schedule_follow_up"
  ]);
  if (ctx.readOnlyTools && writeTools.has(toolCall.function.name)) {
    return permissionError(toolCall.function.name, "read_only_mode");
  }
  const readLimitMax = clampEnvNumber(ctx.env.AGENT_TOOL_READ_LIMIT, 100, 20, 500);

  switch (toolCall.function.name) {
    case "finalize_user_reply": {
      const replyText = typeof args.reply_text === "string" ? args.reply_text.trim() : "";
      if (!replyText) {
        return { ok: false, error: "reply_text_required" };
      }
      finalReplyRef.text = replyText;
      finalReplyRef.finalized = true;
      return { ok: true, finalized: true };
    }

    case "record_feedback": {
      const feedbackType =
        args.feedback_type === "not_a_task" ||
        args.feedback_type === "wrong_assignee" ||
        args.feedback_type === "wrong_status" ||
        args.feedback_type === "wrong_priority" ||
        args.feedback_type === "other"
          ? args.feedback_type
          : null;
      if (!feedbackType) {
        return { ok: false, error: "invalid_feedback_type" };
      }

      const taskId = typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : null;
      const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : null;
      const details =
        typeof args.details === "object" && args.details !== null
          ? (args.details as Record<string, unknown>)
          : {};

      await ctx.env.DB
        .prepare(
          `INSERT INTO task_feedback (
             id, organization_id, workspace_id, conversation_source_id, source_message_id, task_id,
             feedback_type, details_json, actor_platform, actor_id, actor_user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          ctx.organizationId,
          ctx.workspaceId,
          ctx.currentConversationSourceId,
          ctx.event.messageId,
          taskId,
          feedbackType,
          JSON.stringify({ ...(note ? { note } : {}), ...details }),
          "slack",
          ctx.actorExternalUserId,
          ctx.actorInternalUserId,
          new Date().toISOString()
        )
        .run();

      return { ok: true, feedback_type: feedbackType, task_id: taskId };
    }

    case "search_tasks": {
      const searchInput: AclTaskSearchInput = {
        organizationId: ctx.organizationId,
        readableConversationSourceIds: ctx.readableConversationSourceIds,
        allowUnscoped: true,
        limit: clampLimit(args.limit, 20, readLimitMax)
      };
      if (typeof args.query === "string" && args.query.trim()) {
        searchInput.query = args.query.trim();
      }
      let assigneeResolutionSource: "directory" | "workspace_lookup" | "raw_unresolved" | null = null;
      let requestedAssignee = "";
      let resolvedAssignee: string | null = null;
      if (typeof args.assignee_user_id === "string" && args.assignee_user_id.trim()) {
        requestedAssignee = args.assignee_user_id.trim();
        const resolved = await resolveAssigneeExternalUserId({
          requested: requestedAssignee,
          ctx,
          allowWorkspaceLookupFallback: false
        });
        searchInput.assigneeId = resolved.resolvedExternalUserId;
        resolvedAssignee = resolved.resolvedExternalUserId;
        assigneeResolutionSource = resolved.source;
      }
      const statuses = asTaskStatusList(args.statuses);
      if (statuses) {
        searchInput.statuses = statuses;
      }

      let tasks = await ctx.repo.searchTasksWithAcl(searchInput);

      if (
        tasks.length === 0 &&
        requestedAssignee &&
        assigneeResolutionSource === "raw_unresolved"
      ) {
        const fallback = await resolveAssigneeExternalUserId({
          requested: requestedAssignee,
          ctx,
          allowWorkspaceLookupFallback: true
        });
        if (
          fallback.source === "workspace_lookup" &&
          fallback.resolvedExternalUserId !== searchInput.assigneeId
        ) {
          const retryInput: AclTaskSearchInput = {
            ...searchInput,
            assigneeId: fallback.resolvedExternalUserId
          };
          tasks = await ctx.repo.searchTasksWithAcl(retryInput);
          resolvedAssignee = fallback.resolvedExternalUserId;
          assigneeResolutionSource = fallback.source;
        }
      }

      return {
        ok: true,
        tasks: tasks.map((task) => summarizeTask(task)),
        ...(requestedAssignee
          ? {
              assignee_resolution: {
                requested: requestedAssignee,
                resolved: resolvedAssignee,
                source: assigneeResolutionSource
              }
            }
          : {})
      };
    }

    case "get_notes": {
      const scopeType = asNoteScopeType(args.scope_type);
      const scopeId = typeof args.scope_id === "string" ? args.scope_id.trim() : "";
      if (!scopeType || !scopeId) {
        return { ok: false, error: "invalid_scope" };
      }

      if (scopeType === "conversation" && !ctx.readableConversationSourceIds.includes(scopeId)) {
        return permissionError(toolCall.function.name, "conversation_not_readable");
      }

      const notes = await ctx.repo.listAgentNotes({
        organizationId: ctx.organizationId,
        scopeType,
        scopeId,
        limit: clampLimit(args.limit, 20, readLimitMax)
      });
      return {
        ok: true,
        notes: notes.map((note) => ({
          id: note.id,
          content: note.content,
          visibility: note.visibility,
          author_type: note.authorType,
          created_at: note.createdAt
        }))
      };
    }

    case "write_note": {
      const scopeType = asNoteScopeType(args.scope_type);
      const scopeId = typeof args.scope_id === "string" ? args.scope_id.trim() : "";
      const visibility = asVisibility(args.visibility);
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!scopeType || !scopeId || !visibility || !content) {
        return { ok: false, error: "invalid_note_input" };
      }

      if (scopeType === "conversation" && !ctx.readableConversationSourceIds.includes(scopeId)) {
        return permissionError(toolCall.function.name, "conversation_not_readable");
      }
      if (scopeType === "user" && scopeId !== ctx.actorInternalUserId) {
        return permissionError(toolCall.function.name, "user_scope_not_allowed");
      }
      if (scopeType === "person" && scopeId !== ctx.actorPersonId) {
        const workspaceUsers = await ctx.repo.listWorkspaceUsers({
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          limit: 200
        });
        const personIds = new Set<string>();
        for (const workspaceUser of workspaceUsers) {
          const linkedPerson = await ctx.repo.getPersonByUserId(ctx.organizationId, workspaceUser.userId);
          if (linkedPerson?.id) {
            personIds.add(linkedPerson.id);
          }
        }
        if (!personIds.has(scopeId)) {
          return permissionError(toolCall.function.name, "person_scope_not_allowed");
        }
      }

      await ctx.repo.addAgentNote({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        scopeType,
        scopeId,
        visibility,
        content,
        authorType: "agent",
        sourceConversationSourceId: ctx.currentConversationSourceId,
        metadata: {
          source: "tool_agent_runtime"
        },
        createdAt: new Date().toISOString()
      });

      notesWrittenCountRef.count += 1;
      return { ok: true };
    }

    case "get_conversation_context": {
      const requestedSourceId =
        typeof args.conversation_source_id === "string" && args.conversation_source_id.trim()
          ? args.conversation_source_id.trim()
          : ctx.currentConversationSourceId;

      if (!ctx.readableConversationSourceIds.includes(requestedSourceId)) {
        return permissionError(toolCall.function.name, "conversation_not_readable");
      }

      const source = await ctx.resolver.getConversationSourceById({
        organizationId: ctx.organizationId,
        conversationSourceId: requestedSourceId
      });
      if (!source) {
        return { ok: false, error: "conversation_source_not_found" };
      }
      if (source.workspaceId !== ctx.workspaceId) {
        return permissionError(toolCall.function.name, "cross_workspace_not_allowed");
      }

      let messages: Awaited<ReturnType<typeof fetchSlackConversationHistory>> = [];
      try {
        messages = await fetchSlackConversationHistory({
          botToken: ctx.botToken,
          channelId: source.providerConversationId,
          limit: clampLimit(args.limit, 30, readLimitMax),
          maxPages: 2
        });
      } catch (error) {
        return {
          ok: false,
          error: "conversation_history_fetch_failed",
          reason: error instanceof Error ? error.message : String(error)
        };
      }

      return {
        ok: true,
        conversation_source_id: source.id,
        messages: messages
          .slice(-clampLimit(args.limit, 30, readLimitMax))
          .map((message) => ({
            user: message.user ?? null,
            ts: message.ts ?? null,
            text: message.text ?? null,
            reactions: (message.reactions ?? []).map((reaction) => ({
              name: reaction.name ?? null,
              users: reaction.users ?? []
            }))
          }))
      };
    }

    case "search_readable_conversations": {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const requestedKind =
        args.conversation_kind === "public_channel" ||
        args.conversation_kind === "private_channel" ||
        args.conversation_kind === "group_dm" ||
        args.conversation_kind === "dm"
          ? args.conversation_kind
          : null;

      const sources = await ctx.resolver.listReadableConversationSources({
        organizationId: ctx.organizationId,
        userId: ctx.actorInternalUserId,
        limit: clampLimit(args.limit, 50, readLimitMax)
      });
      const filtered = sources
        .filter((source) => source.workspaceId === ctx.workspaceId)
        .filter((source) => (requestedKind ? source.conversationKind === requestedKind : true))
        .filter((source) => {
          if (!query) {
            return true;
          }
          return (
            source.providerConversationId.toLowerCase().includes(query) ||
            source.conversationKind.toLowerCase().includes(query)
          );
        });

      return {
        ok: true,
        conversations: filtered.map((source) => ({
          id: source.id,
          provider_conversation_id: source.providerConversationId,
          conversation_kind: source.conversationKind,
          is_public: source.isPublic
        }))
      };
    }

    case "get_task_timeline": {
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      if (!taskId) {
        return { ok: false, error: "task_id_required" };
      }

      const timeline = await ctx.repo.listTaskTimelineWithAcl({
        organizationId: ctx.organizationId,
        taskId,
        readableConversationSourceIds: ctx.readableConversationSourceIds,
        limit: clampLimit(args.limit, 40, readLimitMax)
      });
      return { ok: true, task_id: taskId, timeline };
    }

    case "search_workspace_people": {
      const people = await ctx.repo.listWorkspaceUsers({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        limit: clampLimit(args.limit, 30, readLimitMax)
      });

      const enriched = await Promise.all(
        people.map(async (person) => {
          const linkedPerson = await ctx.repo.getPersonByUserId(ctx.organizationId, person.userId);
          return {
            user_id: person.userId,
            external_user_id: person.externalUserId,
            display_name: person.displayName ?? null,
            email: person.email ?? null,
            person_id: linkedPerson?.id ?? null
          };
        })
      );

      return { ok: true, people: enriched };
    }

    case "create_task": {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) {
        return { ok: false, error: "title_required" };
      }

      const assigneeExternal =
        typeof args.assignee_user_id === "string" && args.assignee_user_id.trim()
          ? (
              await resolveAssigneeExternalUserId({
                requested: args.assignee_user_id,
                ctx,
                allowWorkspaceLookupFallback: true
              })
            ).resolvedExternalUserId
          : await inferAssigneeFromConversationContext(ctx);

      const task: TaskRecord = {
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        primaryConversationSourceId: ctx.currentConversationSourceId,
        channelId: ctx.event.channelId,
        sourceMessageId: ctx.event.messageId,
        title,
        assignee: {
          platform: "slack",
          platformUserId: assigneeExternal
        },
        assigner: {
          platform: "slack",
          platformUserId: ctx.actorExternalUserId
        },
        createdAt: new Date().toISOString(),
        urgency: asUrgency(args.urgency),
        difficulty: asDifficulty(args.difficulty),
        status: "incomplete",
        confidence: 0.7,
        metadata: {
          extractor: "tool_agent_runtime",
          message_id: ctx.event.messageId
        }
      };

      if (typeof args.description === "string" && args.description.trim()) {
        task.description = args.description.trim();
      }
      if (typeof args.due_at === "string" && args.due_at.trim()) {
        const parsed = new Date(args.due_at);
        if (!Number.isNaN(parsed.valueOf())) {
          task.dueAt = parsed.toISOString();
        }
      }

      await ctx.repo.save(task);
      await ctx.repo.performTaskAction({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        taskId: task.id,
        actionType: "create",
        actorPlatform: "slack",
        actorId: ctx.actorExternalUserId,
        sourceConversationSourceId: ctx.currentConversationSourceId,
        payload: {
          tool: "create_task"
        },
        createdAt: new Date().toISOString()
      });

      ctx.createdTaskIds.push(task.id);
      ctx.taskActionTypes.add("create");
      return { ok: true, task: summarizeTask(task) };
    }

    case "update_task": {
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      const actionType = asTaskActionType(args.action_type);
      if (!taskId || !actionType || actionType === "create") {
        return { ok: false, error: "invalid_task_update_input" };
      }

      const readableTask = await ctx.repo.getTaskByIdWithAcl({
        organizationId: ctx.organizationId,
        taskId,
        readableConversationSourceIds: ctx.readableConversationSourceIds,
        allowUnscoped: true
      });
      if (!readableTask) {
        return permissionError(toolCall.function.name, "task_not_readable");
      }

      let status: TaskStatus | undefined;
      if (
        args.status === "incomplete" ||
        args.status === "in_progress" ||
        args.status === "blocked" ||
        args.status === "done" ||
        args.status === "cancelled"
      ) {
        status = args.status;
      }

      const updateInput: {
        id: string;
        organizationId: string;
        workspaceId: string;
        taskId: string;
        actionType: TaskActionType;
        actorPlatform: "slack";
        actorId: string;
        sourceConversationSourceId: string;
        status?: TaskStatus;
        title?: string;
        description?: string;
        dueAt?: string;
        targetTaskId?: string;
        payload: Record<string, unknown>;
        createdAt: string;
      } = {
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        taskId,
        actionType,
        actorPlatform: "slack",
        actorId: ctx.actorExternalUserId,
        sourceConversationSourceId: ctx.currentConversationSourceId,
        payload: {
          tool: "update_task"
        },
        createdAt: new Date().toISOString()
      };

      if (status) {
        updateInput.status = status;
      }
      if (typeof args.title === "string") {
        updateInput.title = args.title;
      }
      if (typeof args.description === "string") {
        updateInput.description = args.description;
      }
      if (typeof args.due_at === "string") {
        updateInput.dueAt = args.due_at;
      }
      if (typeof args.target_task_id === "string") {
        updateInput.targetTaskId = args.target_task_id;
      }

      await ctx.repo.performTaskAction(updateInput);

      updatedTaskIds.add(taskId);
      ctx.taskActionTypes.add(actionType);
      return { ok: true, task_id: taskId, action_type: actionType };
    }

    case "request_permission_waiver": {
      const resourceType = typeof args.resource_type === "string" ? args.resource_type.trim() : "";
      const resourceId = typeof args.resource_id === "string" ? args.resource_id.trim() : "";
      const requestedScopeType = asNoteScopeType(args.requested_scope_type);
      const requestedScopeId = typeof args.requested_scope_id === "string" ? args.requested_scope_id.trim() : "";
      const reason = typeof args.reason === "string" ? args.reason.trim() : undefined;

      if (!resourceType || !resourceId || !requestedScopeType || !requestedScopeId) {
        return { ok: false, error: "invalid_waiver_input" };
      }

      if (requestedScopeType === "conversation" && !ctx.readableConversationSourceIds.includes(requestedScopeId)) {
        return permissionError(toolCall.function.name, "conversation_scope_not_readable");
      }

      const waiverInput: {
        id: string;
        organizationId: string;
        resourceType: string;
        resourceId: string;
        requesterUserId: string;
        requestedScopeType: NoteScopeType;
        requestedScopeId: string;
        requestReason?: string;
        requestedAt: string;
        metadata: Record<string, unknown>;
      } = {
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        resourceType,
        resourceId,
        requesterUserId: ctx.actorInternalUserId,
        requestedScopeType,
        requestedScopeId,
        requestedAt: new Date().toISOString(),
        metadata: {
          source: "tool_agent_runtime"
        }
      };
      if (reason) {
        waiverInput.requestReason = reason;
      }

      await ctx.repo.requestPermissionWaiver(waiverInput);

      waiversRequestedCountRef.count += 1;
      return { ok: true };
    }

    case "get_notification_cadence": {
      const cadence = await ctx.repo.getUserNotificationCadence({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.actorInternalUserId
      });

      if (!cadence) {
        return {
          ok: true,
          is_configured: false,
          default_cadence: {
            timezone: "UTC",
            cadence_json: defaultCadenceSpec(),
            cadence_summary: "Once per working day"
          }
        };
      }

      return {
        ok: true,
        is_configured: true,
        cadence: {
          timezone: cadence.timezone,
          cadence_json: cadence.cadenceJson,
          cadence_summary: cadence.cadenceSummary ?? null,
          is_enabled: cadence.isEnabled,
          next_digest_at: cadence.nextDigestAt ?? null,
          last_digest_at: cadence.lastDigestAt ?? null
        }
      };
    }

    case "set_notification_cadence": {
      const nowIso = new Date().toISOString();
      const existing = await ctx.repo.getUserNotificationCadence({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.actorInternalUserId
      });

      const existingCadenceJson = existing?.cadenceJson ?? (defaultCadenceSpec() as unknown as Record<string, unknown>);
      const rawCadenceJson =
        args.cadence_json && typeof args.cadence_json === "object"
          ? (args.cadence_json as Record<string, unknown>)
          : existingCadenceJson;

      const normalizedSpec = normalizeCadenceSpec(rawCadenceJson);
      const timezone = normalizeTimezone(typeof args.timezone === "string" ? args.timezone : existing?.timezone ?? "UTC");
      const isEnabled = typeof args.is_enabled === "boolean" ? args.is_enabled : (existing?.isEnabled ?? true);
      const cadenceSummary =
        typeof args.cadence_summary === "string" && args.cadence_summary.trim()
          ? args.cadence_summary.trim()
          : existing?.cadenceSummary ?? "Custom cadence";

      const nextDigestAt = isEnabled
        ? computeNextDigestAt({
            cadenceJson: normalizedSpec as unknown as Record<string, unknown>,
            timezone,
            nowIso,
            fromIso: nowIso
          })
        : null;

      await ctx.repo.upsertUserNotificationCadence({
        id: existing?.id ?? crypto.randomUUID(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.actorInternalUserId,
        platform: "slack",
        externalUserId: ctx.actorExternalUserId,
        isEnabled,
        timezone,
        cadenceJson: normalizedSpec as unknown as Record<string, unknown>,
        cadenceSummary,
        ...(nextDigestAt ? { nextDigestAt } : {}),
        ...(existing?.lastDigestAt ? { lastDigestAt: existing.lastDigestAt } : {}),
        updatedAt: nowIso,
        createdAt: existing?.createdAt ?? nowIso
      });

      return {
        ok: true,
        cadence: {
          timezone,
          cadence_json: normalizedSpec,
          cadence_summary: cadenceSummary,
          is_enabled: isEnabled,
          next_digest_at: nextDigestAt
        }
      };
    }

    case "schedule_follow_up": {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const scheduleAtRaw = typeof args.schedule_at === "string" ? args.schedule_at.trim() : "";
      if (!prompt || !scheduleAtRaw) {
        return { ok: false, error: "invalid_follow_up_input" };
      }

      const scheduleAt = parseIsoTimestamp(scheduleAtRaw);
      if (!scheduleAt) {
        return { ok: false, error: "invalid_schedule_at" };
      }

      const nowIso = new Date().toISOString();
      if (new Date(scheduleAt).valueOf() <= new Date(nowIso).valueOf()) {
        return { ok: false, error: "schedule_at_must_be_future" };
      }

      await ctx.repo.enqueueFollowUpJob({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.actorInternalUserId,
        externalUserId: ctx.actorExternalUserId,
        prompt,
        scheduleAt,
        sourceConversationSourceId: ctx.currentConversationSourceId,
        ...(args.context && typeof args.context === "object"
          ? { context: args.context as Record<string, unknown> }
          : {}),
        createdAt: nowIso
      });

      return { ok: true, schedule_at: scheduleAt };
    }

    default:
      return { ok: false, error: `unknown_tool:${toolCall.function.name}` };
  }
}

export async function runConversationalAgentForSlackMessage(input: AgentRuntimeInput): Promise<AgentRunResult> {
  const interactionMode = input.interactionMode ?? "passive_ingest";
  const readOnlyTools = input.readOnlyTools ?? interactionMode === "proactive_followup";
  const maxTurns = clampEnvNumber(input.env.AGENT_MAX_TOOL_TURNS, 8, 1, 20);

  if ((input.env.DEFAULT_LLM_PROVIDER ?? "openai") !== "openai") {
    return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [] };
  }
  if (!input.env.OPENAI_API_KEY) {
    return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [] };
  }

  const repo = new D1TaskRepository(input.env.DB);
  const resolver = new ConversationAccessResolver(input.env.DB);
  const installStore = new SlackInstallStore(input.env.DB);

  const actorUser = await resolver.ensureSlackUser({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    platformUserId: input.event.author.platformUserId,
    nowIso: new Date().toISOString()
  });

  const actorPerson = await repo.resolveOrCreatePersonForIdentity({
    organizationId: input.organizationId,
    provider: "slack",
    externalWorkspaceId: input.externalWorkspaceId,
    externalUserId: input.event.author.platformUserId,
    linkedUserId: actorUser.userId,
    confidence: 0.85,
    nowIso: new Date().toISOString()
  });

  const readableConversationSourceIds = await resolver.listReadableConversationSourceIds({
    organizationId: input.organizationId,
    userId: actorUser.userId
  });

  const slackInstall = await resolveSlackInstall({
    env: input.env,
    installStore,
    externalWorkspaceId: input.externalWorkspaceId
  });
  let botToken = slackInstall.botToken;
  const botUserId = slackInstall.botUserId;

  if (!botToken) {
    return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [] };
  }

  let recentMessages: Awaited<ReturnType<typeof fetchSlackConversationHistory>> = [];
  try {
    recentMessages = await fetchSlackConversationHistory({
      botToken,
      channelId: input.event.channelId,
      limit: 40,
      maxPages: 2
    });
  } catch (error) {
    const envFallbackToken = input.env.SLACK_BOT_TOKEN ?? null;
    if (
      botToken &&
      envFallbackToken &&
      envFallbackToken !== botToken &&
      isSlackAuthError(error)
    ) {
      try {
        recentMessages = await fetchSlackConversationHistory({
          botToken: envFallbackToken,
          channelId: input.event.channelId,
          limit: 40,
          maxPages: 2
        });
        botToken = envFallbackToken;
      } catch (fallbackError) {
        console.warn("agent_runtime_history_fetch_failed", {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          channelId: input.event.channelId,
          reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
      }
      if (recentMessages.length > 0) {
        // history fetched successfully with fallback token
      } else {
        console.warn("agent_runtime_history_fetch_failed", {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          channelId: input.event.channelId,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      console.warn("agent_runtime_history_fetch_failed", {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        channelId: input.event.channelId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const searchSeed = input.event.text
    .replace(/<@[A-Z0-9]+>/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .slice(0, 4)
    .join(" ");

  const visibleTasks = await repo.searchTasksWithAcl({
    organizationId: input.organizationId,
    readableConversationSourceIds,
    allowUnscoped: true,
    query: searchSeed || input.event.text.slice(0, 60),
    limit: 20
  });

  const organizationNotes = await repo.listAgentNotes({
    organizationId: input.organizationId,
    scopeType: "organization",
    scopeId: input.organizationId,
    limit: 15
  });
  const workspaceNotes = await repo.listAgentNotes({
    organizationId: input.organizationId,
    scopeType: "workspace",
    scopeId: input.workspaceId,
    limit: 15
  });
  const conversationNotes = await repo.listAgentNotes({
    organizationId: input.organizationId,
    scopeType: "conversation",
    scopeId: input.conversationSourceId,
    limit: 15
  });
  const userNotes = await repo.listAgentNotes({
    organizationId: input.organizationId,
    scopeType: "user",
    scopeId: actorUser.userId,
    limit: 15
  });
  const personNotes = await repo.listAgentNotes({
    organizationId: input.organizationId,
    scopeType: "person",
    scopeId: actorPerson.id,
    limit: 15
  });
  const userCadence = await repo.getUserNotificationCadence({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    userId: actorUser.userId
  });

  const readableConversations = await resolver.listReadableConversationSources({
    organizationId: input.organizationId,
    userId: actorUser.userId,
    limit: 50
  });
  const workspacePeopleSeed = await repo.listWorkspaceUsers({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    limit: 100
  });
  const activeConversationParticipants = await resolver.listActiveSlackConversationParticipants({
    organizationId: input.organizationId,
    conversationSourceId: input.conversationSourceId
  });
  const activeConversationMembers = activeConversationParticipants
    .map((participant) => participant.externalUserId)
    .filter((id) => id !== botUserId);

  const participantPersonNotes = (
    await Promise.all(
      activeConversationParticipants
        .filter((participant) => participant.externalUserId !== botUserId)
        .slice(0, 12)
        .map(async (participant) => {
          const internalUserId = await resolver.resolveInternalUserId({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            platform: "slack",
            platformUserId: participant.externalUserId
          });
          if (!internalUserId) {
            return null;
          }
          const linkedPerson = await repo.getPersonByUserId(input.organizationId, internalUserId);
          if (!linkedPerson) {
            return null;
          }
          const notes = await repo.listAgentNotes({
            organizationId: input.organizationId,
            scopeType: "person",
            scopeId: linkedPerson.id,
            limit: 5
          });
          if (notes.length === 0) {
            return null;
          }
          return {
            external_user_id: participant.externalUserId,
            display_name: participant.displayName ?? null,
            person_id: linkedPerson.id,
            notes: notes.map((note) => note.content)
          };
        })
    )
  ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const recentSpeakerCandidates: string[] = [];
  const speakerSeen = new Set<string>();
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const message = recentMessages[i];
    if (!message) {
      continue;
    }
    const userId = message.user?.trim();
    if (!userId || userId === input.event.author.platformUserId || message.subtype || speakerSeen.has(userId)) {
      continue;
    }
    speakerSeen.add(userId);
    recentSpeakerCandidates.push(userId);
  }

  const initialContext = {
    organization_id: input.organizationId,
    workspace_id: input.workspaceId,
    external_workspace_id: input.externalWorkspaceId,
    actor: {
      external_user_id: input.event.author.platformUserId,
      internal_user_id: actorUser.userId,
      person_id: actorPerson.id
    },
    current_event: {
      channel_id: input.event.channelId,
      message_id: input.event.messageId,
      occurred_at: input.event.occurredAt,
      text: input.event.text
    },
    readable_conversation_source_ids: readableConversationSourceIds,
    readable_conversations: readableConversations.map((source) => ({
      id: source.id,
      provider_conversation_id: source.providerConversationId,
      kind: source.conversationKind,
      is_public: source.isPublic
    })),
    recent_channel_messages: recentMessages.slice(-30).map((message) => ({
      ts: message.ts ?? null,
      user: message.user ?? null,
      text: message.text ?? null,
      reactions: (message.reactions ?? []).map((reaction) => ({
        name: reaction.name ?? null,
        users: reaction.users ?? []
      }))
    })),
    assignee_candidates: {
      recent_speakers: recentSpeakerCandidates,
      active_channel_members: activeConversationMembers.filter((id) => id !== input.event.author.platformUserId)
    },
    workspace_people_seed: workspacePeopleSeed.map((person) => ({
      external_user_id: person.externalUserId,
      display_name: person.displayName ?? null,
      email: person.email ?? null
    })),
    conversation_participants: activeConversationParticipants
      .filter((participant) => participant.externalUserId !== botUserId)
      .map((participant) => ({
        external_user_id: participant.externalUserId,
        display_name: participant.displayName ?? null,
        is_actor: participant.externalUserId === input.event.author.platformUserId
      })),
    visible_tasks_seed: visibleTasks.map((task) => summarizeTask(task)),
    notes: {
      organization: organizationNotes.map((note) => note.content),
      workspace: workspaceNotes.map((note) => note.content),
      conversation: conversationNotes.map((note) => note.content),
      user: userNotes.map((note) => note.content),
      person: personNotes.map((note) => note.content),
      participant_person_notes: participantPersonNotes
    },
    notification_cadence: userCadence
      ? {
          timezone: userCadence.timezone,
          cadence_json: userCadence.cadenceJson,
          cadence_summary: userCadence.cadenceSummary ?? null,
          is_enabled: userCadence.isEnabled,
          next_digest_at: userCadence.nextDigestAt ?? null
        }
      : null
  };

  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: systemPrompt(interactionMode)
    },
    {
      role: "user",
      content: `Context JSON:\n${JSON.stringify(initialContext)}\n\nAnalyze the event and use tools to read/write as needed.`
    }
  ];

  const createdTaskIds: string[] = [];
  const taskActionTypes = new Set<TaskActionType>();
  const updatedTaskIds = new Set<string>();
  const notesWrittenCountRef = { count: 0 };
  const waiversRequestedCountRef = { count: 0 };
  const finalReplyRef: { text?: string; finalized: boolean } = { finalized: false };
  let usedTools = false;
  let finalSummary: string | undefined;
  let replyText: string | undefined;

  const ctx: ToolContext = {
    env: input.env,
    repo,
    resolver,
    installStore,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    externalWorkspaceId: input.externalWorkspaceId,
    actorExternalUserId: input.event.author.platformUserId,
    actorInternalUserId: actorUser.userId,
    actorPersonId: actorPerson.id,
    readableConversationSourceIds,
    currentConversationSourceId: input.conversationSourceId,
    botToken,
    createdTaskIds,
    taskActionTypes,
    recentMessages,
    event: input.event,
    interactionMode,
    readOnlyTools,
    workspaceUsers: workspacePeopleSeed,
    ...(botUserId ? { botExternalUserId: botUserId } : {})
  };

  agent_loop: for (let turn = 0; turn < maxTurns; turn += 1) {
    const selectedModel = input.env.DEFAULT_LLM_MODEL ?? "gpt-4.1-mini";
    const payload = await callChatCompletionWithRetry({
      env: input.env,
      body: {
        model: selectedModel,
        temperature: 0,
        tool_choice: "auto",
        parallel_tool_calls: false,
        tools: toolDefinitions(interactionMode),
        messages
      }
    });
    await recordLlmUsageEvent({
      env: input.env,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      conversationSourceId: input.conversationSourceId,
      sourceMessageId: input.event.messageId,
      model: selectedModel,
      interactionMode,
      payload
    });

    const assistantMessage = payload.choices?.[0]?.message;
    if (!assistantMessage) {
      break;
    }

    const toolCalls = assistantMessage.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: assistantMessage.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    });

    if (toolCalls.length === 0) {
      if (typeof assistantMessage.content === "string" && assistantMessage.content.trim()) {
        const content = assistantMessage.content.trim();
        if (interactionMode === "dm_reply" || interactionMode === "proactive_followup") {
          replyText = content;
        } else {
          finalSummary = content;
        }
      }
      break;
    }

    usedTools = true;

    for (const toolCall of toolCalls) {
      let result: Record<string, unknown>;
      try {
        result = await executeTool(
          toolCall,
          ctx,
          updatedTaskIds,
          notesWrittenCountRef,
          waiversRequestedCountRef,
          finalReplyRef
        );
      } catch (error) {
        result = {
          ok: false,
          error: "tool_execution_failed",
          tool: toolCall.function.name,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });

      if (finalReplyRef.finalized && (interactionMode === "dm_reply" || interactionMode === "proactive_followup")) {
        break agent_loop;
      }
    }
  }

  const summaryObject = {
    summary: finalSummary ?? "agent_run_complete",
    created_task_ids: createdTaskIds,
    updated_task_ids: Array.from(updatedTaskIds),
    notes_written: notesWrittenCountRef.count,
    waivers_requested: waiversRequestedCountRef.count
  };

  const result: AgentRunResult = {
    usedTools,
    createdTaskIds,
    updatedTaskIds: Array.from(updatedTaskIds),
    taskActionTypes: Array.from(taskActionTypes)
  };

  if (interactionMode === "passive_ingest") {
    result.finalSummary = JSON.stringify(summaryObject);
  } else if (finalSummary) {
    result.finalSummary = finalSummary;
  }

  if (finalReplyRef.text && (interactionMode === "dm_reply" || interactionMode === "proactive_followup")) {
    result.replyText = finalReplyRef.text;
  } else if (replyText && (interactionMode === "dm_reply" || interactionMode === "proactive_followup")) {
    result.replyText = replyText;
  } else if (interactionMode === "dm_reply" || interactionMode === "proactive_followup") {
    result.replyText =
      "I’m here and listening. I couldn’t complete that response just now, but if you rephrase or try again I’ll handle it.";
  }

  return result;
}

export async function runProactiveFollowUpForSlackUser(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  conversationSourceId: string;
  channelId: string;
  externalUserId: string;
  prompt: string;
  context?: Record<string, unknown>;
}): Promise<AgentRunResult> {
  const promptContext = input.context ? `\n\nContext JSON:\n${JSON.stringify(input.context)}` : "";
  return runConversationalAgentForSlackMessage({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    externalWorkspaceId: input.externalWorkspaceId,
    conversationSourceId: input.conversationSourceId,
    interactionMode: "proactive_followup",
    readOnlyTools: true,
    event: {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      messageId: `followup:${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      text: `Proactive follow-up instruction: ${input.prompt}${promptContext}`,
      author: {
        platform: "slack",
        platformUserId: input.externalUserId
      }
    }
  });
}
