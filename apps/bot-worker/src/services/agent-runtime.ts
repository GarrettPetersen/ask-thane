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
import {
  evaluateActiveUserGateForTaskWrite,
  evaluateFreeTierAiSpendGateForTaskWrite,
  recordWorkspaceUserActivity,
  resolveModelForWorkspaceTier,
  resolveWorkspaceBillingPolicy,
  type WorkspaceBillingPolicy
} from "./billing-policy";
import { ConversationAccessResolver } from "./conversation-access";
import { createSignedBillingSubscribeUrl } from "./billing-link-token";
import { computeNextDigestAt, defaultCadenceSpec, normalizeCadenceSpec, normalizeTimezone } from "./notification-cadence";
import { estimateOpenAiUsageCost } from "./openai-pricing";
import {
  fetchSlackConversationHistory,
  fetchSlackThreadReplies,
  postSlackMessage
} from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface ConversationalAgentInput {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  conversationSourceId: string;
  event: MessageEvent;
  interactionMode?: "passive_ingest" | "dm_reply" | "proactive_followup";
  readOnlyTools?: boolean;
  adapter?: AgentRuntimeAdapter;
  actorEmail?: string;
  actorDisplayName?: string;
}

interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ChatCompletionToolCall[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: ChatCompletionMessage;
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
  eventTypes: string[];
  finalSummary?: string;
  replyText?: string;
}

type AgentPlatform = "slack" | "thane_cli";

interface AgentHistoryReaction {
  name?: string;
  users?: string[];
}

interface AgentHistoryMessage {
  user?: string;
  messageId?: string;
  threadRootId?: string;
  text?: string;
  subtype?: string;
  reactions?: AgentHistoryReaction[];
}

interface AgentRuntimeAdapter {
  platform: AgentPlatform;
  botExternalUserId?: string;
  fetchConversationHistory(input: { providerConversationId: string; limit: number; maxPages: number }): Promise<AgentHistoryMessage[]>;
  fetchThreadReplies(input: { providerConversationId: string; threadId: string; limit: number; maxPages: number }): Promise<AgentHistoryMessage[]>;
  sendBillingNotice?(input: { channelId: string; text: string; threadId?: string }): Promise<void>;
}

interface RuntimeUserRef {
  userId: string;
  externalUserId: string;
  displayName?: string;
  email?: string;
}

interface ToolContext {
  env: BotEnv;
  repo: D1TaskRepository;
  resolver: ConversationAccessResolver;
  installStore: SlackInstallStore;
  platform: AgentPlatform;
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  actorExternalUserId: string;
  actorInternalUserId: string;
  actorPersonId?: string;
  readableConversationSourceIds: string[];
  currentConversationSourceId: string;
  createdTaskIds: string[];
  taskActionTypes: Set<TaskActionType>;
  eventTypes: Set<string>;
  recentMessages: AgentHistoryMessage[];
  event: MessageEvent;
  interactionMode: "passive_ingest" | "dm_reply" | "proactive_followup";
  readOnlyTools: boolean;
  botExternalUserId?: string;
  adapter: AgentRuntimeAdapter;
  workspaceUsers: Array<{ userId: string; externalUserId: string; displayName?: string; email?: string }>;
  billingPolicy: WorkspaceBillingPolicy;
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

function clampNonNegative(limit: unknown, fallback: number, max: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(limit), 0), max);
}

function fromSlackHistoryMessages(
  messages: Array<{
    user?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    subtype?: string;
    reactions?: AgentHistoryReaction[];
  }>
): AgentHistoryMessage[] {
  return messages.map((message) => {
    const normalized: AgentHistoryMessage = {};
    if (message.user) {
      normalized.user = message.user;
    }
    if (message.ts) {
      normalized.messageId = message.ts;
    }
    if (message.thread_ts) {
      normalized.threadRootId = message.thread_ts;
    }
    if (message.text) {
      normalized.text = message.text;
    }
    if (message.subtype) {
      normalized.subtype = message.subtype;
    }
    if (message.reactions) {
      normalized.reactions = message.reactions;
    }
    return normalized;
  });
}

function mergeAgentHistoryMessages(
  ...messageSets: Array<AgentHistoryMessage[] | null | undefined>
): AgentHistoryMessage[] {
  const byTs = new Map<string, AgentHistoryMessage>();
  let fallbackCounter = 0;
  for (const set of messageSets) {
    if (!set) {
      continue;
    }
    for (const message of set) {
      const messageId = message.messageId?.trim();
      if (messageId) {
        byTs.set(messageId, message);
      } else {
        fallbackCounter += 1;
        byTs.set(`fallback:${fallbackCounter}:${message.user ?? "unknown"}:${message.text ?? ""}`, message);
      }
    }
  }
  return Array.from(byTs.values()).sort((a, b) => Number(a.messageId ?? "0") - Number(b.messageId ?? "0"));
}

function toAgentContextMessage(message: AgentHistoryMessage): Record<string, unknown> {
  return {
    message_id: message.messageId ?? null,
    thread_id: message.threadRootId ?? null,
    user: message.user ?? null,
    text: message.text ?? null,
    reactions: (message.reactions ?? []).map((reaction) => ({
      name: reaction.name ?? null,
      users: reaction.users ?? []
    }))
  };
}

async function ensureNativeRuntimeUser(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  externalUserId: string;
  displayName?: string;
  email?: string;
}): Promise<RuntimeUserRef> {
  const existing = await input.env.DB
    .prepare(
      `SELECT id, external_user_id, display_name, email
       FROM users
       WHERE organization_id = ?
         AND workspace_id = ?
         AND platform = 'thane_cli'
         AND external_user_id = ?
       LIMIT 1`
    )
    .bind(input.organizationId, input.workspaceId, input.externalUserId)
    .first<Record<string, unknown>>();
  if (existing?.id) {
    return {
      userId: String(existing.id),
      externalUserId: String(existing.external_user_id ?? input.externalUserId),
      ...(existing.display_name ? { displayName: String(existing.display_name) } : {}),
      ...(existing.email ? { email: String(existing.email) } : {})
    };
  }

  const nowIso = new Date().toISOString();
  const userId = `usr_thane_${crypto.randomUUID().replace(/-/g, "")}`;
  await input.env.DB
    .prepare(
      `INSERT INTO users (id, organization_id, workspace_id, platform, external_user_id, display_name, email, role, created_at, updated_at)
       VALUES (?, ?, ?, 'thane_cli', ?, ?, ?, 'member', ?, ?)`
    )
    .bind(
      userId,
      input.organizationId,
      input.workspaceId,
      input.externalUserId,
      input.displayName ?? input.externalUserId,
      input.email ?? null,
      nowIso,
      nowIso
    )
    .run();

  return {
    userId,
    externalUserId: input.externalUserId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.email ? { email: input.email } : {})
  };
}

async function ensureNativeAskThaneMemberForRuntime(env: BotEnv, workspaceId: string): Promise<string> {
  const existing = await env.DB
    .prepare("SELECT id FROM thane_cli_workspace_members WHERE workspace_id = ? AND email = 'thane@askthane.com' AND left_at IS NULL LIMIT 1")
    .bind(workspaceId)
    .first<{ id?: string }>();
  if (existing?.id) {
    return existing.id;
  }
  const nowIso = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_workspace_members (
         id, workspace_id, account_id, email, display_name, handle, role, joined_at, updated_at
       ) VALUES (?, ?, 'acct_thane', 'thane@askthane.com', 'Ask Thane', 'thane', 'member', ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         display_name = excluded.display_name,
         handle = excluded.handle,
         left_at = NULL,
         updated_at = excluded.updated_at`
    )
    .bind(id, workspaceId, nowIso, nowIso)
    .run();
  const row = await env.DB
    .prepare("SELECT id FROM thane_cli_workspace_members WHERE workspace_id = ? AND email = 'thane@askthane.com' AND left_at IS NULL LIMIT 1")
    .bind(workspaceId)
    .first<{ id?: string }>();
  return row?.id ?? id;
}

function createNativeThaneChatAdapter(input: {
  env: BotEnv;
  workspaceId: string;
}): AgentRuntimeAdapter {
  async function readMessages(providerConversationId: string, limit: number, threadId?: string): Promise<AgentHistoryMessage[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const rows = await input.env.DB
      .prepare(
        `SELECT msg.id, msg.thread_root_id, msg.text, msg.created_at, member.handle
         FROM thane_cli_chat_messages msg
         JOIN thane_cli_workspace_members member ON member.id = msg.author_member_id
         WHERE msg.workspace_id = ?
           AND msg.channel_id = ?
           AND (? IS NULL OR msg.id = ? OR msg.thread_root_id = ?)
         ORDER BY msg.created_at DESC
         LIMIT ?`
      )
      .bind(input.workspaceId, providerConversationId, threadId ?? null, threadId ?? null, threadId ?? null, cappedLimit)
      .all<{ id: string; thread_root_id: string | null; text: string; created_at: string; handle: string }>();
    return (rows.results ?? [])
      .reverse()
      .map((row) => ({
        user: row.handle,
        messageId: row.id,
        ...(row.thread_root_id ? { threadRootId: row.thread_root_id } : {}),
        text: row.text
      }));
  }

  return {
    platform: "thane_cli",
    botExternalUserId: "thane",
    fetchConversationHistory: ({ providerConversationId, limit, maxPages }) => readMessages(providerConversationId, limit * maxPages),
    fetchThreadReplies: ({ providerConversationId, threadId, limit, maxPages }) => readMessages(providerConversationId, limit * maxPages, threadId),
    sendBillingNotice: async ({ channelId, text, threadId }) => {
      const botMemberId = await ensureNativeAskThaneMemberForRuntime(input.env, input.workspaceId);
      const nowIso = new Date().toISOString();
      await input.env.DB
        .prepare(
          `INSERT INTO thane_cli_chat_messages (
             id, workspace_id, channel_id, author_member_id, text, source, origin, thread_root_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'terminal', 'webhook', ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), input.workspaceId, channelId, botMemberId, text, threadId ?? null, nowIso, nowIso)
        .run();
    }
  };
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
  const sharedIntentGroupId =
    typeof task.metadata?.shared_intent_group_id === "string" ? task.metadata.shared_intent_group_id : null;
  const sharedAssigneeCount =
    typeof task.metadata?.shared_assignee_count === "number" ? task.metadata.shared_assignee_count : null;
  const sharedAssigneeIndex =
    typeof task.metadata?.shared_assignee_index === "number" ? task.metadata.shared_assignee_index : null;
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    assignee_user_id: task.assignee.platformUserId,
    assigner_user_id: task.assigner.platformUserId,
    urgency: task.urgency,
    difficulty: task.difficulty,
    created_at: task.createdAt,
    due_at: task.dueAt ?? null,
    channel_id: task.channelId ?? null,
    source_message_id: task.sourceMessageId ?? null,
    shared_intent_group_id: sharedIntentGroupId,
    shared_assignee_count: sharedAssigneeCount,
    shared_assignee_index: sharedAssigneeIndex
  };
}

function toolDefinitions(mode: "passive_ingest" | "dm_reply" | "proactive_followup") {
  const tools = [
    {
      type: "function",
      function: {
        name: "search_tasks",
        description:
          "Search visible tasks in the organization with ACL already enforced. assignee_user_id accepts platform external_user_id and workspace user_id.",
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
            limit: { type: "number" },
            thread_id: { type: "string" },
            thread_ts: { type: "string", description: "Deprecated alias for thread_id." }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_conversation_messages",
        description:
          "Search readable conversation history by text and return matching messages plus surrounding context lines.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string" },
            conversation_source_id: { type: "string" },
            thread_id: { type: "string" },
            thread_ts: { type: "string", description: "Deprecated alias for thread_id." },
            limit: { type: "number" },
            context_window: { type: "number" },
            max_pages: { type: "number" }
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
        description:
          "Create a new task from conversational intent. Infer urgency/difficulty from context when not explicit. Infer due_at when reasonably supported by context. Keep title concise and action-focused; put collaborator/background detail in description. Do not use this for adding details to an existing task.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["title", "urgency", "difficulty"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            assignee_user_id: { type: "string" },
            assignee_user_ids: {
              type: "array",
              items: { type: "string" }
            },
            urgency: { type: "string", enum: ["low", "medium", "high", "critical"] },
            difficulty: { type: "string", enum: ["low", "medium", "high"] },
            due_at: { type: "string" },
            confirm_separate_task_when_similar: { type: "boolean" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_task",
        description:
          "Apply a task action to an existing task when state changed from conversation. Use action_type='edit' for metadata updates (title, description, due_at, urgency, difficulty, assignee_user_id).",
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
            due_at: { type: ["string", "null"] },
            urgency: { type: "string", enum: ["low", "medium", "high", "critical"] },
            difficulty: { type: "string", enum: ["low", "medium", "high"] },
            assignee_user_id: { type: "string" },
            target_task_id: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "add_task_details",
        description:
          "Add or replace descriptive details on an existing task without creating a new task. Use this when someone adds context/notes/details to already tracked work.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["task_id", "details_text"],
          properties: {
            task_id: { type: "string" },
            details_text: { type: "string" },
            replace_existing: { type: "boolean" }
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
        tool.function.name !== "add_task_details" &&
        tool.function.name !== "record_feedback" &&
        tool.function.name !== "write_note" &&
        tool.function.name !== "request_permission_waiver" &&
        tool.function.name !== "set_notification_cadence" &&
        tool.function.name !== "schedule_follow_up"
    );
  }

  return tools;
}

function finalizeReplyToolDefinition() {
  return {
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
  } as const;
}

function extractReplyTextFromAssistantMessage(message: ChatCompletionMessage | undefined): string | null {
  if (!message) {
    return null;
  }

  const toolCalls = message.tool_calls ?? [];
  for (const toolCall of toolCalls) {
    if (toolCall.function.name !== "finalize_user_reply") {
      continue;
    }
    try {
      const args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      const replyText = typeof args.reply_text === "string" ? args.reply_text.trim() : "";
      if (replyText) {
        return replyText;
      }
    } catch {
      // Ignore malformed tool arguments and continue searching for a usable reply.
    }
  }

  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (content) {
    return content;
  }
  return null;
}

async function recoverMissingReplyText(input: {
  env: BotEnv;
  model: string;
  organizationId: string;
  workspaceId: string;
  conversationSourceId: string;
  sourceMessageId: string;
  interactionMode: "dm_reply" | "proactive_followup";
  messages: Array<Record<string, unknown>>;
}): Promise<string | null> {
  const recoveryAttempts = clampEnvNumber(input.env.AGENT_DM_REPLY_RECOVERY_ATTEMPTS, 2, 1, 4);
  const recoveryInstruction =
    "Recovery mode: provide a direct helpful answer now. Call finalize_user_reply with reply_text. Do not ask the user to rephrase.";

  for (let attempt = 1; attempt <= recoveryAttempts; attempt += 1) {
    const payload = await callChatCompletionWithRetry({
      env: input.env,
      body: {
        model: input.model,
        temperature: 0,
        parallel_tool_calls: false,
        tools: [finalizeReplyToolDefinition()],
        tool_choice: {
          type: "function",
          function: { name: "finalize_user_reply" }
        },
        messages: [
          ...input.messages,
          {
            role: "user",
            content: `${recoveryInstruction} Attempt ${attempt} of ${recoveryAttempts}.`
          }
        ]
      }
    });

    await recordLlmUsageEvent({
      env: input.env,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      conversationSourceId: input.conversationSourceId,
      sourceMessageId: input.sourceMessageId,
      model: input.model,
      interactionMode: input.interactionMode,
      payload
    });

    const assistantMessage = payload.choices?.[0]?.message;
    const recoveredText = extractReplyTextFromAssistantMessage(assistantMessage);
    if (recoveredText) {
      return recoveredText;
    }
  }

  return null;
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
    "When task relevance or implied intent is ambiguous, use read tools first (search_tasks, get_notes, search_workspace_people, search_readable_conversations, get_conversation_context, search_conversation_messages) to ground your decision.",
    "Treat reactions, mentions, and historical notes as signals, not certainty.",
    "Infer the organization's operating context (business domain, team norms, channel purpose) from notes, participant patterns, prior tasks, and recent conversation context before deciding what is task-worthy.",
    "Track tasks that are relevant to this organization's context; avoid tracking personal errands/chatter that are clearly out-of-scope for the org.",
    "Examples: in a household-oriented workspace, 'get groceries' may be a valid task; in a work-oriented workspace, casual personal groceries chatter is usually not a tracked task.",
    "A single message may contain multiple independent task events; detect each event and apply all needed tool calls in the same run.",
    "For statements that imply progress/completion/cancellation/blocking, always search existing tasks first and update matching tasks instead of creating duplicates.",
    "For each clause: (1) classify clause intent, (2) if it references existing work then update_task, (3) if it introduces new work then create_task.",
    "When someone adds details or context to existing work, do not create a new task for that instruction; use add_task_details (or update_task edit) on the existing task.",
    "Never create meta-instruction tasks like 'add details to ...' or 'update task ...'; those are instructions to Thane, not work items.",
    "Keep task titles concise and action-focused; avoid embedding assignee names in the title (for example avoid '... with Danika').",
    "Put supporting context, collaborator notes, and constraints into description instead of the title.",
    "For every created or edited task, set urgency and difficulty using explicit cues when present and contextual judgment when implicit.",
    "Infer due dates from temporal cues (for example today/this week/by Friday) and normalize to ISO when possible; if timing is truly unclear, leave due_at unset.",
    "When urgency/difficulty/due date changes are implied, use update_task with action_type='edit' to update those fields.",
    "Some statements imply urgent work even without imperative wording; when context indicates operational impact, infer and track the implied task.",
    "Examples: 'the website is down' in a web business context implies an incident task to restore service (and possibly investigation/fix follow-up).",
    "Counter-example: 'I need to pick up my kids' in a work channel is usually context/explanation, not a trackable org task.",
    "If one clause closes or changes an existing task and another clause introduces remaining or new work, emit both update_task and create_task actions.",
    "If someone reports completed work and no matching task exists, you may create a historical task and immediately mark it done so completion is tracked.",
    "When users correct Thane (for example not-a-task, wrong assignee, wrong status), record this feedback with record_feedback and then make corrective task updates when possible.",
    "When reading tasks (for example when listing/searching), detect obvious malformed tracker artifacts from prior mistakes and repair them in the same run before replying.",
    "Repair strategy: prefer update_task(edit) to correct title/description, add_task_details to move context into description, and mark_cancelled/merge_into for stray helper tasks.",
    "Examples: 'I am done the dishes, but I still need to water the gnomes' => mark_done(dishes) + create_task(water gnomes) if missing.",
    "Examples: 'I'm done watering the gnomes, but I still need to elevate the cake and bloviate the sneed' => mark_done(water gnomes) + create_task(elevate cake) + create_task(bloviate sneed).",
    "Examples: 'I froze the beef last night' should update existing freeze-beef task to done when a matching open task exists.",
    "Examples: if someone says they finished work and no task exists, create_task(that work) + update_task(mark_done) in the same run.",
    "When assignee is not explicit, treat first-person commitments as self-assigned by default.",
    "When the task is a delegation to someone else, set assignee_user_id explicitly after using workspace people/context tools.",
    "When work is clearly committed by a collective (for example team-level or first-person plural commitment), you may assign multiple people by using assignee_user_ids and create linked per-assignee tasks.",
    "If create_task returns potential_duplicate_tasks, make the final judgment call: merge/update when it is the same work, or call create_task again with confirm_separate_task_when_similar=true when similar wording still represents separate work.",
    "When ownership changes on an existing task (for example 'I'll do it myself' or assignee correction), use update_task(action_type='edit') with assignee_user_id to reassign.",
    "If linked shared-assignee tasks exist and one person takes sole ownership, keep only that person's task open and close the other linked assignee tasks.",
    "Interpret deictic second-person address using conversation context: when the speaker addresses another participant (for example 'you' in a shared channel), do not assign to the speaker unless context explicitly indicates self-assignment.",
    "When users reference prior messages with phrases like 'those', 'that list', or 'who did each of those', resolve the referent by reading recent conversation or searching message history before replying.",
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

async function resolveAssigneeExternalUserIds(input: {
  requested: unknown;
  ctx: ToolContext;
  allowWorkspaceLookupFallback: boolean;
}): Promise<string[]> {
  if (!Array.isArray(input.requested)) {
    return [];
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.requested) {
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = await resolveAssigneeExternalUserId({
      requested: trimmed,
      ctx: input.ctx,
      allowWorkspaceLookupFallback: input.allowWorkspaceLookupFallback
    });
    if (seen.has(candidate.resolvedExternalUserId)) {
      continue;
    }
    seen.add(candidate.resolvedExternalUserId);
    resolved.push(candidate.resolvedExternalUserId);
  }
  return resolved;
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

function resolveInternalUserIdByExternalUserId(
  workspaceUsers: Array<{ userId: string; externalUserId: string }>,
  externalUserId: string
): string | null {
  const matched = workspaceUsers.find((user) => user.externalUserId === externalUserId);
  return matched?.userId ?? null;
}

function formatResetDateForMessage(resetIso: string): string {
  const reset = new Date(resetIso);
  if (Number.isNaN(reset.valueOf())) {
    return resetIso;
  }
  return reset.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function freeTierAiLimitMessage(input: {
  monthlySpendUsd: number;
  monthlyCapUsd: number;
  resetsAtIso: string;
  subscriptionPageUrl: string;
}): string {
  const spend = input.monthlySpendUsd.toFixed(2);
  const cap = input.monthlyCapUsd.toFixed(2);
  const resetDate = formatResetDateForMessage(input.resetsAtIso);
  return (
    `Thane has reached this workspace's free-tier AI usage limit ($${cap}/month; current usage $${spend}). ` +
    `It can't track additional tasks until ${resetDate}. ` +
    `To continue using Thane, upgrade to a paid subscription: ${input.subscriptionPageUrl}`
  );
}

async function enforceActorActiveUserLimitForTaskWrites(ctx: ToolContext): Promise<Record<string, unknown> | null> {
  const aiGate = await evaluateFreeTierAiSpendGateForTaskWrite({
    env: ctx.env,
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId
  });
  if (!aiGate.allowed) {
    return {
      ok: false,
      error: "free_tier_ai_spend_limit_reached",
      message: freeTierAiLimitMessage({
        monthlySpendUsd: aiGate.monthlySpendUsd,
        monthlyCapUsd: aiGate.monthlyCapUsd,
        resetsAtIso: aiGate.resetsAtIso,
        subscriptionPageUrl: await createSignedBillingSubscribeUrl({
          env: ctx.env,
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId
        })
      }),
      resets_at: aiGate.resetsAtIso,
      monthly_spend_usd: aiGate.monthlySpendUsd,
      monthly_cap_usd: aiGate.monthlyCapUsd
    };
  }

  const actorGate = await evaluateActiveUserGateForTaskWrite({
    env: ctx.env,
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    externalUserId: ctx.actorExternalUserId
  });
  if (actorGate.allowed) {
    return null;
  }
  return {
    ok: false,
    error: "free_tier_active_user_limit_reached",
    message:
      "This workspace is on the free tier and has reached its active-user limit. This task action was ignored for billing safety."
  };
}

async function filterAssigneesByActiveUserPolicy(input: {
  ctx: ToolContext;
  assigneeExternalUserIds: string[];
}): Promise<{
  allowed: string[];
  skipped: Array<{ assignee_user_id: string; reason: string }>;
}> {
  const allowed: string[] = [];
  const skipped: Array<{ assignee_user_id: string; reason: string }> = [];
  for (const assigneeExternalUserId of input.assigneeExternalUserIds) {
    const gate = await evaluateActiveUserGateForTaskWrite({
      env: input.ctx.env,
      organizationId: input.ctx.organizationId,
      workspaceId: input.ctx.workspaceId,
      externalUserId: assigneeExternalUserId
    });
    if (gate.allowed) {
      allowed.push(assigneeExternalUserId);
      continue;
    }
    skipped.push({
      assignee_user_id: assigneeExternalUserId,
      reason: "free_tier_active_user_limit_reached"
    });
  }
  return { allowed, skipped };
}

async function trackTaskActivityForUsers(input: {
  ctx: ToolContext;
  eventType: string;
  externalUserIds: string[];
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const seen = new Set<string>();
  for (const externalUserId of input.externalUserIds) {
    const normalized = externalUserId.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    await recordWorkspaceUserActivity({
      env: input.ctx.env,
      organizationId: input.ctx.organizationId,
      workspaceId: input.ctx.workspaceId,
      userId: resolveInternalUserIdByExternalUserId(input.ctx.workspaceUsers, normalized),
      externalUserId: normalized,
      eventType: input.eventType,
      sourceConversationSourceId: input.ctx.currentConversationSourceId,
      sourceMessageId: input.ctx.event.messageId,
      ...(input.metadata ? { metadata: input.metadata } : {})
    });
  }
}

async function maybeTrackActorConversationActivity(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  userId: string;
  externalUserId: string;
  conversationSourceId: string;
  sourceMessageId: string;
  interactionMode: "passive_ingest" | "dm_reply" | "proactive_followup";
}): Promise<void> {
  const gate = await evaluateActiveUserGateForTaskWrite({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    externalUserId: input.externalUserId
  });
  if (!gate.allowed && !gate.countedUserIsAlreadyActive) {
    return;
  }
  await recordWorkspaceUserActivity({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    externalUserId: input.externalUserId,
    eventType: `interaction_${input.interactionMode}`,
    sourceConversationSourceId: input.conversationSourceId,
    sourceMessageId: input.sourceMessageId,
    metadata: {
      source: "agent_runtime"
    }
  });
}

function parseIsoTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date.toISOString();
}

function tokenizeTitleForSimilarity(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function titleTokenJaccard(a: string, b: string): number {
  const aTokens = new Set(tokenizeTitleForSimilarity(a));
  const bTokens = new Set(tokenizeTitleForSimilarity(b));
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function isLikelyDuplicateTaskTitle(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.length >= 8 && right.length >= 8 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  return titleTokenJaccard(left, right) >= 0.67;
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
  const costs = estimateOpenAiUsageCost({
    env: input.env,
    model: input.model,
    promptTokens,
    completionTokens
  });

  await input.env.DB
    .prepare(
      `INSERT INTO llm_usage_events (
         id, organization_id, workspace_id, provider, model, prompt_tokens, completion_tokens,
         total_tokens, prompt_cost_usd, completion_cost_usd, total_cost_usd, currency, pricing_version,
         api_endpoint, request_type, source, source_message_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      costs.promptCostUsd,
      costs.completionCostUsd,
      costs.totalCostUsd,
      costs.currency,
      costs.pricingVersion,
      "chat_completions",
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
    "add_task_details",
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
          ctx.platform,
          ctx.actorExternalUserId,
          ctx.actorInternalUserId,
          new Date().toISOString()
        )
        .run();

      ctx.eventTypes.add("feedback_recorded");
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
      ctx.eventTypes.add("note_written");
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

      const requestedThreadId =
        typeof args.thread_id === "string" && args.thread_id.trim()
          ? args.thread_id.trim()
          : typeof args.thread_ts === "string"
            ? args.thread_ts.trim()
            : "";
      let messages: AgentHistoryMessage[] = [];
      try {
        messages = await ctx.adapter.fetchConversationHistory({
          providerConversationId: source.providerConversationId,
          limit: clampLimit(args.limit, 30, readLimitMax),
          maxPages: 2
        });
        if (requestedThreadId) {
          try {
            const threadMessages = await ctx.adapter.fetchThreadReplies({
              providerConversationId: source.providerConversationId,
              threadId: requestedThreadId,
              limit: clampLimit(args.limit, 30, readLimitMax),
              maxPages: 2
            });
            messages = mergeAgentHistoryMessages(messages, threadMessages);
          } catch (threadError) {
            return {
              ok: true,
              conversation_source_id: source.id,
              thread_id: requestedThreadId,
              thread_fetch_warning: threadError instanceof Error ? threadError.message : String(threadError),
              messages: messages
                .slice(-clampLimit(args.limit, 30, readLimitMax))
                .map(toAgentContextMessage)
            };
          }
        }
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
        ...(requestedThreadId ? { thread_id: requestedThreadId } : {}),
        messages: messages
          .slice(-clampLimit(args.limit, 30, readLimitMax))
          .map(toAgentContextMessage)
      };
    }

    case "search_conversation_messages": {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      if (!query) {
        return { ok: false, error: "query_required" };
      }

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

      const searchMaxPages = clampEnvNumber(ctx.env.AGENT_MESSAGE_SEARCH_MAX_PAGES, 6, 1, 20);
      const contextWindow = clampNonNegative(args.context_window, 2, 10);
      const matchLimit = clampLimit(args.limit, 8, 50);
      const requestedThreadId =
        typeof args.thread_id === "string" && args.thread_id.trim()
          ? args.thread_id.trim()
          : typeof args.thread_ts === "string"
            ? args.thread_ts.trim()
            : "";

      let messages: AgentHistoryMessage[] = [];
      try {
        const channelMessages = await ctx.adapter.fetchConversationHistory({
          providerConversationId: source.providerConversationId,
          limit: clampLimit(args.limit, 120, readLimitMax),
          maxPages: clampLimit(args.max_pages, Math.min(4, searchMaxPages), searchMaxPages)
        });
        messages = channelMessages;
        if (requestedThreadId) {
          try {
            const threadMessages = await ctx.adapter.fetchThreadReplies({
              providerConversationId: source.providerConversationId,
              threadId: requestedThreadId,
              limit: clampLimit(args.limit, 120, readLimitMax),
              maxPages: clampLimit(args.max_pages, Math.min(4, searchMaxPages), searchMaxPages)
            });
            messages = mergeAgentHistoryMessages(channelMessages, threadMessages);
          } catch {
            // Keep channel messages if thread reads are unavailable for this token/scope.
          }
        }
      } catch (error) {
        return {
          ok: false,
          error: "conversation_history_search_failed",
          reason: error instanceof Error ? error.message : String(error)
        };
      }

      const matchingIndexes: number[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        const text = messages[index]?.text?.toLowerCase() ?? "";
        if (!text || !text.includes(query)) {
          continue;
        }
        matchingIndexes.push(index);
        if (matchingIndexes.length >= matchLimit) {
          break;
        }
      }

      return {
        ok: true,
        conversation_source_id: source.id,
        query,
        ...(requestedThreadId ? { thread_id: requestedThreadId } : {}),
        total_messages_scanned: messages.length,
        matches: matchingIndexes.map((index) => {
          const start = Math.max(0, index - contextWindow);
          const end = Math.min(messages.length, index + contextWindow + 1);
          return {
            index,
            match: toAgentContextMessage(messages[index] as AgentHistoryMessage),
            context: messages.slice(start, end).map(toAgentContextMessage)
          };
        })
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
      const actorLimitError = await enforceActorActiveUserLimitForTaskWrites(ctx);
      if (actorLimitError) {
        return actorLimitError;
      }

      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) {
        return { ok: false, error: "title_required" };
      }

      const explicitAssignees = await resolveAssigneeExternalUserIds({
        requested: args.assignee_user_ids,
        ctx,
        allowWorkspaceLookupFallback: true
      });
      if (
        explicitAssignees.length === 0 &&
        typeof args.assignee_user_id === "string" &&
        args.assignee_user_id.trim()
      ) {
        const single = await resolveAssigneeExternalUserId({
          requested: args.assignee_user_id,
          ctx,
          allowWorkspaceLookupFallback: true
        });
        explicitAssignees.push(single.resolvedExternalUserId);
      }

      const resolvedAssigneeExternals =
        explicitAssignees.length > 0 ? explicitAssignees : [await inferAssigneeFromConversationContext(ctx)];
      const assigneePolicy = await filterAssigneesByActiveUserPolicy({
        ctx,
        assigneeExternalUserIds: resolvedAssigneeExternals
      });
      const assigneeExternals = assigneePolicy.allowed;
      const skippedAssignees = assigneePolicy.skipped;

      if (assigneeExternals.length === 0) {
        return {
          ok: false,
          error: "free_tier_active_user_limit_reached",
          skipped_assignees: skippedAssignees
        };
      }

      const confirmSeparateWhenSimilar = args.confirm_separate_task_when_similar === true;
      const potentialDuplicates: Array<{
        assignee_user_id: string;
        task_id: string;
        title: string;
        status: TaskStatus;
        due_at: string | null;
      }> = [];

      for (const assigneeExternal of assigneeExternals) {
        if (!assigneeExternal) {
          continue;
        }

        const possibleDuplicates = await ctx.repo.searchTasksWithAcl({
          organizationId: ctx.organizationId,
          readableConversationSourceIds: ctx.readableConversationSourceIds,
          allowUnscoped: true,
          assigneeId: assigneeExternal,
          statuses: ["incomplete", "in_progress", "blocked"],
          query: title,
          limit: 30
        });
        const duplicate = possibleDuplicates.find((candidate) => isLikelyDuplicateTaskTitle(candidate.title, title));
        if (duplicate) {
          potentialDuplicates.push({
            assignee_user_id: assigneeExternal,
            task_id: duplicate.id,
            title: duplicate.title,
            status: duplicate.status,
            due_at: duplicate.dueAt ?? null
          });
        }
      }

      if (potentialDuplicates.length > 0 && !confirmSeparateWhenSimilar) {
        return {
          ok: false,
          error: "potential_duplicate_tasks",
          potential_duplicates: potentialDuplicates,
          guidance:
            "If this is the same work, update/merge existing task(s). If intentionally separate, call create_task again with confirm_separate_task_when_similar=true."
        };
      }

      const sharedIntentGroupId = assigneeExternals.length > 1 ? crypto.randomUUID() : null;
      const createdTasks: TaskRecord[] = [];
      const inputDescription = typeof args.description === "string" ? args.description.trim() : "";
      const inputUrgency = asUrgency(args.urgency);
      const inputDifficulty = asDifficulty(args.difficulty);
      const parsedDueAt =
        typeof args.due_at === "string" && args.due_at.trim()
          ? (() => {
              const parsed = new Date(args.due_at);
              return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
            })()
          : null;

      for (let i = 0; i < assigneeExternals.length; i += 1) {
        const assigneeExternal = assigneeExternals[i];
        if (!assigneeExternal) {
          continue;
        }

        const task: TaskRecord = {
          id: crypto.randomUUID(),
          workspaceId: ctx.workspaceId,
          primaryConversationSourceId: ctx.currentConversationSourceId,
          channelId: ctx.event.channelId,
          sourceMessageId: ctx.event.messageId,
          title,
          assignee: {
            platform: ctx.platform,
            platformUserId: assigneeExternal
          },
          assigner: {
            platform: ctx.platform,
            platformUserId: ctx.actorExternalUserId
          },
          createdAt: new Date().toISOString(),
          urgency: inputUrgency,
          difficulty: inputDifficulty,
          status: "incomplete",
          confidence: 0.7,
          metadata: {
            extractor: "tool_agent_runtime",
            message_id: ctx.event.messageId,
            ...(sharedIntentGroupId ? { shared_intent_group_id: sharedIntentGroupId } : {}),
            ...(sharedIntentGroupId ? { shared_assignee_count: assigneeExternals.length } : {}),
            ...(sharedIntentGroupId ? { shared_assignee_index: i } : {})
          }
        };

        if (inputDescription) {
          task.description = inputDescription;
        }
        if (parsedDueAt) {
          task.dueAt = parsedDueAt;
        }

        await ctx.repo.save(task);
        await ctx.repo.performTaskAction({
          id: crypto.randomUUID(),
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          taskId: task.id,
          actionType: "create",
          actorPlatform: ctx.platform,
          actorId: ctx.actorExternalUserId,
          sourceConversationSourceId: ctx.currentConversationSourceId,
          payload: {
            tool: "create_task",
            source_message_id: ctx.event.messageId,
            source_channel_id: ctx.event.channelId,
            source_text: ctx.event.text,
            ...(sharedIntentGroupId ? { shared_intent_group_id: sharedIntentGroupId } : {})
          },
          createdAt: new Date().toISOString()
        });
        createdTasks.push(task);
        ctx.createdTaskIds.push(task.id);
      }

      if (createdTasks.length === 0) {
        return { ok: false, error: "no_assignees_resolved", skipped_assignees: skippedAssignees };
      }

      await trackTaskActivityForUsers({
        ctx,
        eventType: "task_create",
        externalUserIds: [ctx.actorExternalUserId, ...assigneeExternals],
        metadata: {
          tool: "create_task",
          created_task_count: createdTasks.length
        }
      });

      ctx.taskActionTypes.add("create");
      return {
        ok: true,
        tasks: createdTasks.map((task) => summarizeTask(task)),
        task_ids: createdTasks.map((task) => task.id),
        ...(skippedAssignees.length > 0 ? { skipped_assignees: skippedAssignees } : {}),
        ...(sharedIntentGroupId ? { shared_intent_group_id: sharedIntentGroupId } : {})
      };
    }

    case "update_task": {
      const actorLimitError = await enforceActorActiveUserLimitForTaskWrites(ctx);
      if (actorLimitError) {
        return actorLimitError;
      }

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
        actorPlatform: AgentPlatform;
        actorId: string;
        sourceConversationSourceId: string;
        status?: TaskStatus;
        title?: string;
        description?: string;
        dueAt?: string | null;
        urgency?: TaskUrgency;
        difficulty?: TaskDifficulty;
        assigneePlatform?: AgentPlatform;
        assigneeId?: string;
        assigneeName?: string | null;
        targetTaskId?: string;
        payload: Record<string, unknown>;
        createdAt: string;
      } = {
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        taskId,
        actionType,
        actorPlatform: ctx.platform,
        actorId: ctx.actorExternalUserId,
        sourceConversationSourceId: ctx.currentConversationSourceId,
        payload: {
          tool: "update_task",
          source_message_id: ctx.event.messageId,
          source_channel_id: ctx.event.channelId,
          source_text: ctx.event.text
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
        const trimmed = args.due_at.trim();
        if (trimmed) {
          const parsed = new Date(trimmed);
          if (!Number.isNaN(parsed.valueOf())) {
            updateInput.dueAt = parsed.toISOString();
          }
        }
      } else if (args.due_at === null) {
        updateInput.dueAt = null;
      }
      if (args.urgency === "low" || args.urgency === "medium" || args.urgency === "high" || args.urgency === "critical") {
        updateInput.urgency = args.urgency;
      }
      if (args.difficulty === "low" || args.difficulty === "medium" || args.difficulty === "high") {
        updateInput.difficulty = args.difficulty;
      }
      if (typeof args.assignee_user_id === "string" && args.assignee_user_id.trim()) {
        const resolved = await resolveAssigneeExternalUserId({
          requested: args.assignee_user_id,
          ctx,
          allowWorkspaceLookupFallback: true
        });
        const assigneeGate = await evaluateActiveUserGateForTaskWrite({
          env: ctx.env,
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          externalUserId: resolved.resolvedExternalUserId
        });
        if (!assigneeGate.allowed) {
          return {
            ok: false,
            error: "free_tier_active_user_limit_reached",
            assignee_user_id: resolved.resolvedExternalUserId
          };
        }
        updateInput.assigneePlatform = ctx.platform;
        updateInput.assigneeId = resolved.resolvedExternalUserId;
        const matchedUser = ctx.workspaceUsers.find((user) => user.externalUserId === resolved.resolvedExternalUserId);
        updateInput.assigneeName = matchedUser?.displayName ?? null;
        updateInput.payload.assignee_resolution = {
          requested: args.assignee_user_id,
          resolved_external_user_id: resolved.resolvedExternalUserId,
          source: resolved.source
        };
      }
      if (typeof args.target_task_id === "string") {
        updateInput.targetTaskId = args.target_task_id;
      }

      await ctx.repo.performTaskAction(updateInput);
      await trackTaskActivityForUsers({
        ctx,
        eventType: "task_update",
        externalUserIds: [
          ctx.actorExternalUserId,
          ...(updateInput.assigneeId ? [updateInput.assigneeId] : [])
        ],
        metadata: {
          tool: "update_task",
          action_type: actionType
        }
      });

      updatedTaskIds.add(taskId);
      ctx.taskActionTypes.add(actionType);
      return { ok: true, task_id: taskId, action_type: actionType };
    }

    case "add_task_details": {
      const actorLimitError = await enforceActorActiveUserLimitForTaskWrites(ctx);
      if (actorLimitError) {
        return actorLimitError;
      }

      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      const detailsText = typeof args.details_text === "string" ? args.details_text.trim() : "";
      const replaceExisting = args.replace_existing === true;
      if (!taskId || !detailsText) {
        return { ok: false, error: "invalid_add_task_details_input" };
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

      const currentDescription = readableTask.description?.trim() ?? "";
      const nextDescription = replaceExisting
        ? detailsText
        : currentDescription
          ? `${currentDescription}\n\n${detailsText}`
          : detailsText;

      await ctx.repo.performTaskAction({
        id: crypto.randomUUID(),
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        taskId,
        actionType: "edit",
        actorPlatform: ctx.platform,
        actorId: ctx.actorExternalUserId,
        sourceConversationSourceId: ctx.currentConversationSourceId,
        description: nextDescription,
        payload: {
          tool: "add_task_details",
          source_message_id: ctx.event.messageId,
          source_channel_id: ctx.event.channelId,
          source_text: ctx.event.text,
          replace_existing: replaceExisting
        },
        createdAt: new Date().toISOString()
      });
      await trackTaskActivityForUsers({
        ctx,
        eventType: "task_update",
        externalUserIds: [ctx.actorExternalUserId],
        metadata: {
          tool: "add_task_details"
        }
      });

      updatedTaskIds.add(taskId);
      ctx.taskActionTypes.add("edit");
      return {
        ok: true,
        task_id: taskId,
        description: nextDescription,
        replace_existing: replaceExisting
      };
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
      ctx.eventTypes.add("permission_waiver_requested");
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
        platform: ctx.platform,
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

      ctx.eventTypes.add("notification_cadence_updated");
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
      if (ctx.billingPolicy.planTier === "free") {
        return {
          ok: false,
          error: "plan_limit_reached",
          reason: "schedule_follow_up_requires_paid_tier"
        };
      }

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

      ctx.eventTypes.add("follow_up_scheduled");
      return { ok: true, schedule_at: scheduleAt };
    }

    default:
      return { ok: false, error: `unknown_tool:${toolCall.function.name}` };
  }
}

export const __testables = {
  toolDefinitions,
  executeTool,
  extractReplyTextFromAssistantMessage
};

export async function runConversationalAgent(input: ConversationalAgentInput): Promise<AgentRunResult> {
  const interactionMode = input.interactionMode ?? "passive_ingest";
  const readOnlyTools = input.readOnlyTools ?? interactionMode === "proactive_followup";
  const configuredMaxTurns = clampEnvNumber(input.env.AGENT_MAX_TOOL_TURNS, 8, 1, 20);
  const platform = input.adapter?.platform ?? "slack";

  if ((input.env.DEFAULT_LLM_PROVIDER ?? "openai") !== "openai") {
    return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [], eventTypes: [] };
  }
  if (!input.env.OPENAI_API_KEY) {
    return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [], eventTypes: [] };
  }

  const repo = new D1TaskRepository(input.env.DB);
  const resolver = new ConversationAccessResolver(input.env.DB);
  const installStore = new SlackInstallStore(input.env.DB);
  const workspaceBillingPolicy = await resolveWorkspaceBillingPolicy({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId
  });
  const maxTurns = workspaceBillingPolicy.planTier === "free" ? Math.min(configuredMaxTurns, 4) : configuredMaxTurns;

  const actorUser =
    platform === "slack"
      ? await resolver.ensureSlackUser({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          platformUserId: input.event.author.platformUserId,
          nowIso: new Date().toISOString()
        })
      : await ensureNativeRuntimeUser({
          env: input.env,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          externalUserId: input.event.author.platformUserId,
          ...(input.actorDisplayName ?? input.event.author.displayName ? { displayName: input.actorDisplayName ?? input.event.author.displayName } : {}),
          ...(input.actorEmail ? { email: input.actorEmail } : {})
        });

  const actorPerson = await repo.resolveOrCreatePersonForIdentity({
    organizationId: input.organizationId,
    provider: platform,
    externalWorkspaceId: input.externalWorkspaceId,
    externalUserId: input.event.author.platformUserId,
    linkedUserId: actorUser.userId,
    ...(input.actorEmail ? { email: input.actorEmail } : {}),
    ...(input.actorDisplayName ?? input.event.author.displayName ? { displayName: input.actorDisplayName ?? input.event.author.displayName } : {}),
    confidence: 0.85,
    isVerified: platform === "thane_cli" && Boolean(input.actorEmail),
    nowIso: new Date().toISOString()
  });

  await maybeTrackActorConversationActivity({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    userId: actorUser.userId,
    externalUserId: input.event.author.platformUserId,
    conversationSourceId: input.conversationSourceId,
    sourceMessageId: input.event.messageId,
    interactionMode
  });

  const readableConversationSourceIds = await resolver.listReadableConversationSourceIds({
    organizationId: input.organizationId,
    userId: actorUser.userId
  });

  let botToken: string | null = null;
  let runtimeAdapter: AgentRuntimeAdapter | null = input.adapter ?? null;
  if (!input.adapter) {
    const slackInstall = await resolveSlackInstall({
      env: input.env,
      installStore,
      externalWorkspaceId: input.externalWorkspaceId
    });
    botToken = slackInstall.botToken;
    const botUserId = slackInstall.botUserId;
    if (!botToken) {
      return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [], eventTypes: [] };
    }
    const adapterBotToken = botToken;
    runtimeAdapter = {
      platform: "slack",
      ...(botUserId ? { botExternalUserId: botUserId } : {}),
      fetchConversationHistory: async ({ providerConversationId, limit, maxPages }) =>
        fromSlackHistoryMessages(await fetchSlackConversationHistory({
          botToken: adapterBotToken,
          channelId: providerConversationId,
          limit,
          maxPages
        })),
      fetchThreadReplies: async ({ providerConversationId, threadId, limit, maxPages }) =>
        fromSlackHistoryMessages(await fetchSlackThreadReplies({
          botToken: adapterBotToken,
          channelId: providerConversationId,
          threadTs: threadId,
          limit,
          maxPages
        })),
      sendBillingNotice: ({ channelId, text, threadId }) =>
        postSlackMessage({
          botToken: adapterBotToken,
          channelId,
          text,
          ...(threadId ? { threadTs: threadId } : {})
        }).then(() => undefined)
    };
  }
  if (!runtimeAdapter) {
    return { usedTools: false, createdTaskIds: [], updatedTaskIds: [], taskActionTypes: [], eventTypes: [] };
  }

  const runAiSpendGate = await evaluateFreeTierAiSpendGateForTaskWrite({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId
  });
  if (!runAiSpendGate.allowed) {
    const message = freeTierAiLimitMessage({
      monthlySpendUsd: runAiSpendGate.monthlySpendUsd,
      monthlyCapUsd: runAiSpendGate.monthlyCapUsd,
      resetsAtIso: runAiSpendGate.resetsAtIso,
      subscriptionPageUrl: await createSignedBillingSubscribeUrl({
        env: input.env,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId
      })
    });
    try {
      await runtimeAdapter.sendBillingNotice?.({
        channelId: input.event.channelId,
        text: message,
        threadId: input.event.messageId
      });
    } catch (error) {
      console.warn("agent_runtime_free_tier_ai_cap_notice_failed", {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        channelId: input.event.channelId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    return {
      usedTools: false,
      createdTaskIds: [],
      updatedTaskIds: [],
      taskActionTypes: [],
      eventTypes: ["free_tier_ai_spend_limit_reached"]
    };
  }

  const recentHistoryLimit = clampEnvNumber(input.env.AGENT_RECENT_HISTORY_LIMIT, 40, 10, 200);
  const recentHistoryMaxPages = clampEnvNumber(input.env.AGENT_RECENT_HISTORY_MAX_PAGES, 2, 1, 10);
  const recentContextWindow = clampEnvNumber(input.env.AGENT_RECENT_CONTEXT_WINDOW, 30, 10, 120);
  const threadContextWindow = clampEnvNumber(input.env.AGENT_THREAD_CONTEXT_WINDOW, 20, 5, 120);
  const currentThreadId = input.event.threadTs?.trim() ? input.event.threadTs.trim() : null;

  let recentMessages: AgentHistoryMessage[] = [];
  let recentThreadMessages: AgentHistoryMessage[] = [];
  try {
    const channelMessages = await runtimeAdapter.fetchConversationHistory({
      providerConversationId: input.event.channelId,
      limit: recentHistoryLimit,
      maxPages: recentHistoryMaxPages
    });
    recentMessages = channelMessages;
    if (currentThreadId) {
      try {
        recentThreadMessages = await runtimeAdapter.fetchThreadReplies({
          providerConversationId: input.event.channelId,
          threadId: currentThreadId,
          limit: Math.min(recentHistoryLimit, threadContextWindow),
          maxPages: recentHistoryMaxPages
        });
      } catch (threadError) {
        console.warn("agent_runtime_thread_fetch_failed", {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          channelId: input.event.channelId,
          threadId: currentThreadId,
          reason: threadError instanceof Error ? threadError.message : String(threadError)
        });
      }
    }
    recentMessages = mergeAgentHistoryMessages(recentMessages, recentThreadMessages);
  } catch (error) {
    const envFallbackToken = input.env.SLACK_BOT_TOKEN ?? null;
    if (
      botToken &&
      envFallbackToken &&
      envFallbackToken !== botToken &&
      isSlackAuthError(error)
    ) {
      try {
        const channelMessages = await fetchSlackConversationHistory({
          botToken: envFallbackToken,
          channelId: input.event.channelId,
          limit: recentHistoryLimit,
          maxPages: recentHistoryMaxPages
        });
        recentMessages = fromSlackHistoryMessages(channelMessages);
        if (currentThreadId) {
          try {
            recentThreadMessages = await fetchSlackThreadReplies({
              botToken: envFallbackToken,
              channelId: input.event.channelId,
              threadTs: currentThreadId,
              limit: Math.min(recentHistoryLimit, threadContextWindow),
              maxPages: recentHistoryMaxPages
            }).then(fromSlackHistoryMessages);
          } catch (threadFallbackError) {
            console.warn("agent_runtime_thread_fetch_failed", {
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              channelId: input.event.channelId,
              threadId: currentThreadId,
              reason: threadFallbackError instanceof Error ? threadFallbackError.message : String(threadFallbackError)
            });
          }
        }
        recentMessages = mergeAgentHistoryMessages(recentMessages, recentThreadMessages);
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

  const searchSeed = input.event.text.trim().slice(0, 120);

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
  const activeConversationParticipants =
    runtimeAdapter.platform === "slack"
      ? await resolver.listActiveSlackConversationParticipants({
          organizationId: input.organizationId,
          conversationSourceId: input.conversationSourceId
        })
      : workspacePeopleSeed.map((person) => ({
          userId: person.userId,
          externalUserId: person.externalUserId,
          displayName: person.displayName,
          email: person.email
        }));
  const activeConversationMembers = activeConversationParticipants
    .map((participant) => participant.externalUserId)
    .filter((id) => id !== runtimeAdapter.botExternalUserId);

  const participantPersonNotes = (
    await Promise.all(
      activeConversationParticipants
        .filter((participant) => participant.externalUserId !== runtimeAdapter.botExternalUserId)
        .slice(0, 12)
        .map(async (participant) => {
          const internalUserId = await resolver.resolveInternalUserId({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            platform: runtimeAdapter.platform,
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
      thread_id: currentThreadId,
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
    recent_channel_messages: recentMessages.slice(-recentContextWindow).map(toAgentContextMessage),
    ...(currentThreadId
      ? {
          recent_thread_messages: recentThreadMessages.slice(-threadContextWindow).map(toAgentContextMessage)
        }
      : {}),
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
      .filter((participant) => participant.externalUserId !== runtimeAdapter.botExternalUserId)
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
      : null,
    billing_policy: {
      plan_tier: workspaceBillingPolicy.planTier,
      included_active_users: workspaceBillingPolicy.includedActiveUsers,
      hard_cap_active_users: workspaceBillingPolicy.hardCapActiveUsers,
      included_ai_cost_usd: workspaceBillingPolicy.includedAiCostUsd
    }
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
  const eventTypes = new Set<string>();
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
    platform: runtimeAdapter.platform,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    externalWorkspaceId: input.externalWorkspaceId,
    actorExternalUserId: input.event.author.platformUserId,
    actorInternalUserId: actorUser.userId,
    actorPersonId: actorPerson.id,
    readableConversationSourceIds,
    currentConversationSourceId: input.conversationSourceId,
    createdTaskIds,
    taskActionTypes,
    eventTypes,
    recentMessages,
    event: input.event,
    interactionMode,
    readOnlyTools,
    adapter: runtimeAdapter,
    workspaceUsers: workspacePeopleSeed,
    billingPolicy: workspaceBillingPolicy,
    ...(runtimeAdapter.botExternalUserId ? { botExternalUserId: runtimeAdapter.botExternalUserId } : {})
  };

  const selectedModel = resolveModelForWorkspaceTier({
    env: input.env,
    planTier: workspaceBillingPolicy.planTier,
    usage: "agent"
  });

  agent_loop: for (let turn = 0; turn < maxTurns; turn += 1) {
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

  if (!finalReplyRef.text && !replyText && (interactionMode === "dm_reply" || interactionMode === "proactive_followup")) {
    eventTypes.add("reply_recovery_attempted");
    try {
      const recovered = await recoverMissingReplyText({
        env: input.env,
        model: selectedModel,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        conversationSourceId: input.conversationSourceId,
        sourceMessageId: input.event.messageId,
        interactionMode,
        messages
      });
      if (recovered) {
        replyText = recovered;
        eventTypes.add("reply_recovery_succeeded");
      } else {
        eventTypes.add("reply_recovery_failed");
      }
    } catch (error) {
      console.warn("agent_runtime_reply_recovery_failed", {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        channelId: input.event.channelId,
        messageId: input.event.messageId,
        reason: error instanceof Error ? error.message : String(error)
      });
      eventTypes.add("reply_recovery_failed");
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
    taskActionTypes: Array.from(taskActionTypes),
    eventTypes: Array.from(eventTypes)
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
  return runConversationalAgent({
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

export async function runConversationalAgentForThaneChatMessage(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  conversationSourceId: string;
  channelId: string;
  authorExternalUserId: string;
  authorEmail?: string;
  authorDisplayName?: string;
  messageId: string;
  text: string;
  threadRootId?: string | null;
  occurredAt?: string;
  interactionMode?: "passive_ingest" | "dm_reply" | "proactive_followup";
  readOnlyTools?: boolean;
}): Promise<AgentRunResult> {
  return runConversationalAgent({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    externalWorkspaceId: input.workspaceId,
    conversationSourceId: input.conversationSourceId,
    adapter: createNativeThaneChatAdapter({
      env: input.env,
      workspaceId: input.workspaceId
    }),
    ...(input.authorEmail ? { actorEmail: input.authorEmail } : {}),
    ...(input.authorDisplayName ? { actorDisplayName: input.authorDisplayName } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.readOnlyTools !== undefined ? { readOnlyTools: input.readOnlyTools } : {}),
    event: {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      messageId: input.messageId,
      ...(input.threadRootId ? { threadTs: input.threadRootId } : {}),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      text: input.text,
      author: {
        platform: "thane_cli",
        platformUserId: input.authorExternalUserId,
        ...(input.authorDisplayName ? { displayName: input.authorDisplayName } : {})
      }
    }
  });
}
