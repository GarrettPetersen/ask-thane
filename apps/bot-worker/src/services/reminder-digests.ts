import { D1TaskRepository, type UserNotificationCadenceRecord } from "@ask-thane/data";
import type { TaskRecord, UserRef } from "@ask-thane/domain";
import { resolveModelForWorkspaceTier, resolveWorkspaceBillingPolicy } from "./billing-policy";
import { ConversationAccessResolver } from "./conversation-access";
import { computeNextDigestAt, defaultCadenceSpec, normalizeCadenceSpec, normalizeTimezone } from "./notification-cadence";
import { estimateOpenAiUsageCost } from "./openai-pricing";
import {
  fetchSlackConversationHistory,
  fetchSlackUserProfile,
  openSlackDirectMessage,
  postSlackMessage,
  type SlackHistoryMessage
} from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
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

interface WorkspaceInstallRef {
  botToken: string;
  botUserId?: string;
  externalWorkspaceId?: string;
}

interface ReminderRunStats {
  usersWithOpenTasks: number;
  dueCadences: number;
  messagesSent: number;
  skippedNoTasks: number;
  skippedUnremindable: number;
  failures: number;
}

interface ReminderDispatchOptions {
  forceSendNoTasks: boolean;
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
}

function taskLine(task: TaskRecord, index: number): string {
  const parts = [`${index + 1}. ${task.title}`];
  parts.push(`status: ${task.status}`);
  parts.push(`asked by ${task.assigner.platform === "slack" ? `<@${task.assigner.platformUserId}>` : `@${task.assigner.platformUserId}`}`);
  parts.push(`created ${formatShortDate(task.createdAt)}`);
  if (task.dueAt) {
    parts.push(`due ${formatShortDate(task.dueAt)}`);
  }
  return `- ${parts.join(" | ")}`;
}

function buildDigestMessage(input: {
  taskCount: number;
  tasks: TaskRecord[];
  cadence: UserNotificationCadenceRecord;
}): string {
  const headline =
    input.taskCount === 0
      ? "You currently have no open tasks."
      : input.taskCount === 1
        ? "You currently have 1 open task."
        : `You currently have ${input.taskCount} open tasks.`;

  const lines = [`Hi, here is your Thane check-in. ${headline}`, ""];
  if (input.taskCount > 0) {
    lines.push(...input.tasks.slice(0, 12).map((task, index) => taskLine(task, index)));
  } else {
    lines.push("- Nothing is currently assigned to you.");
  }

  if (input.taskCount > 12) {
    lines.push(`- ...and ${input.taskCount - 12} more open tasks.`);
  }

  lines.push(
    "",
    "If you want a different reminder cadence, tell me in this DM (for example: twice a day, weekday mornings, Mondays only)."
  );

  if (input.cadence.cadenceSummary) {
    lines.push(`Current cadence: ${input.cadence.cadenceSummary}`);
  }

  return lines.join("\n");
}

function shouldUseAiDigest(planTier: string): boolean {
  return planTier !== "free";
}

function isDmRemindableForInstall(input: {
  profile: { teamId?: string; isStranger?: boolean } | null;
  install: WorkspaceInstallRef;
}): { remindable: boolean; reason?: "missing_profile" | "is_stranger" | "foreign_team" } {
  if (!input.profile) {
    return { remindable: false, reason: "missing_profile" };
  }
  if (input.profile.isStranger) {
    return { remindable: false, reason: "is_stranger" };
  }
  if (
    input.profile.teamId &&
    input.install.externalWorkspaceId &&
    input.profile.teamId !== input.install.externalWorkspaceId
  ) {
    return { remindable: false, reason: "foreign_team" };
  }
  return { remindable: true };
}

function toDigestContextMessages(input: {
  messages: SlackHistoryMessage[];
  recipientExternalUserId: string;
  botUserId?: string;
}): Array<{ speaker: "recipient" | "thane" | "other"; text: string }> {
  return input.messages
    .filter((message) => !message.subtype && typeof message.text === "string" && message.text.trim())
    .slice(-24)
    .map((message) => {
      const userId = message.user?.trim() ?? "";
      const speaker: "recipient" | "thane" | "other" =
        userId === input.recipientExternalUserId
          ? "recipient"
          : userId && input.botUserId && userId === input.botUserId
            ? "thane"
            : "other";
      return {
        speaker,
        text: String(message.text ?? "").trim()
      };
    })
    .filter((entry) => entry.text.length > 0);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function callChatCompletionWithRetry(input: {
  env: BotEnv;
  body: Record<string, unknown>;
  retries?: number;
  timeoutMs?: number;
}): Promise<ChatCompletionResponse> {
  if (!input.env.OPENAI_API_KEY) {
    throw new Error("missing_openai_api_key");
  }

  const retries = Math.min(Math.max(input.retries ?? 2, 0), 4);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30000, 5000), 120000);
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
        throw new Error(`digest_completion_failed:${code}`);
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

  throw lastError ?? new Error("digest_completion_failed:unknown");
}

async function recordLlmUsageEvent(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  source: string;
  sourceMessageId: string;
  model: string;
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
      "reminder_digest",
      input.source,
      input.sourceMessageId,
      new Date().toISOString()
    )
    .run();
}

async function buildAiDigestMessage(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  cadence: UserNotificationCadenceRecord;
  taskCount: number;
  tasks: TaskRecord[];
  contextMessages: Array<{ speaker: "recipient" | "thane" | "other"; text: string }>;
  model: string;
}): Promise<string> {
  const payload = await callChatCompletionWithRetry({
    env: input.env,
    body: {
      model: input.model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "You are Thane sending a recurring task reminder in Slack DM. Keep it concise, specific, and helpful. Mention urgent/critical tasks first, do not invent facts, and end with one short cadence reminder sentence."
        },
        {
          role: "user",
          content: `Compose today's check-in message using this JSON context:\n${JSON.stringify(
            {
              cadence_summary: input.cadence.cadenceSummary ?? null,
              task_count: input.taskCount,
              tasks: input.tasks.slice(0, 20).map((task) => ({
                id: task.id,
                title: task.title,
                description: task.description ?? null,
                status: task.status,
                urgency: task.urgency,
                difficulty: task.difficulty,
                due_at: task.dueAt ?? null,
                asked_by: task.assigner.platformUserId,
                created_at: task.createdAt
              })),
              recent_dm_context: input.contextMessages.slice(-16)
            },
            null,
            2
          )}`
        }
      ]
    }
  });

  await recordLlmUsageEvent({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    source: `digest:${input.cadence.userId}`,
    sourceMessageId: `digest:${input.cadence.userId}:${Date.now()}`,
    model: input.model,
    payload
  });

  const message = payload.choices?.[0]?.message?.content?.trim();
  if (!message) {
    throw new Error("digest_completion_empty");
  }
  return message;
}

async function ensureDefaultCadence(input: {
  repo: D1TaskRepository;
  organizationId: string;
  workspaceId: string;
  userId: string;
  externalUserId: string;
  platform: UserRef["platform"];
  nowIso: string;
}): Promise<UserNotificationCadenceRecord> {
  const existing = await input.repo.getUserNotificationCadence({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    userId: input.userId
  });

  if (existing) {
    return existing;
  }

  const cadenceJson = defaultCadenceSpec() as unknown as Record<string, unknown>;
  await input.repo.upsertUserNotificationCadence({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    platform: input.platform,
    externalUserId: input.externalUserId,
    isEnabled: true,
    timezone: "UTC",
    cadenceJson,
    cadenceSummary: "Once per working day",
    nextDigestAt: input.nowIso,
    updatedAt: input.nowIso,
    createdAt: input.nowIso
  });

  const created = await input.repo.getUserNotificationCadence({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    userId: input.userId
  });
  if (!created) {
    throw new Error("failed_to_create_default_cadence");
  }

  return created;
}

async function ensureNativeAskThaneMember(env: BotEnv, workspaceId: string, nowIso: string): Promise<string> {
  const existing = await env.DB
    .prepare("SELECT id FROM thane_cli_workspace_members WHERE workspace_id = ? AND email = 'thane@askthane.com' LIMIT 1")
    .bind(workspaceId)
    .first<{ id?: string }>();
  if (existing?.id) {
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_workspace_members (
         id, workspace_id, account_id, email, display_name, handle, role, joined_at, updated_at
       ) VALUES (?, ?, ?, 'thane@askthane.com', 'Ask Thane', 'thane', 'member', ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         display_name = excluded.display_name,
         handle = excluded.handle,
         updated_at = excluded.updated_at`
    )
    .bind(id, workspaceId, "acct_thane", nowIso, nowIso)
    .run();
  const row = await env.DB
    .prepare("SELECT id FROM thane_cli_workspace_members WHERE workspace_id = ? AND email = 'thane@askthane.com' LIMIT 1")
    .bind(workspaceId)
    .first<{ id?: string }>();
  return row?.id ?? id;
}

async function dispatchNativeCadenceDigest(input: {
  env: BotEnv;
  repo: D1TaskRepository;
  nowIso: string;
  cadence: UserNotificationCadenceRecord;
  options: ReminderDispatchOptions;
}): Promise<"sent" | "skipped_no_tasks" | "skipped_unremindable_assignee"> {
  const openTasks = await input.repo.listOpenByAssigneeInOrganization(
    input.cadence.organizationId,
    input.cadence.workspaceId,
    input.cadence.externalUserId
  );
  if (openTasks.length === 0 && !input.options.forceSendNoTasks) {
    return "skipped_no_tasks";
  }
  const recipient = await input.env.DB
    .prepare("SELECT id, handle FROM thane_cli_workspace_members WHERE workspace_id = ? AND handle = ? LIMIT 1")
    .bind(input.cadence.workspaceId, input.cadence.externalUserId)
    .first<{ id?: string; handle?: string }>();
  if (!recipient?.id || recipient.handle === "thane") {
    return "skipped_unremindable_assignee";
  }
  const botMemberId = await ensureNativeAskThaneMember(input.env, input.cadence.workspaceId, input.nowIso);
  const dmName = `dm-thane-${recipient.handle}`;
  let channel = await input.env.DB
    .prepare("SELECT id FROM thane_cli_channels WHERE workspace_id = ? AND name = ? LIMIT 1")
    .bind(input.cadence.workspaceId, dmName)
    .first<{ id?: string }>();
  if (!channel?.id) {
    const channelId = crypto.randomUUID();
    await input.env.DB
      .prepare(
        `INSERT INTO thane_cli_channels (
           id, workspace_id, name, kind, visibility, topic, created_at, updated_at
         ) VALUES (?, ?, ?, 'dm', 'private', 'Ask Thane reminders', ?, ?)`
      )
      .bind(channelId, input.cadence.workspaceId, dmName, input.nowIso, input.nowIso)
      .run();
    channel = { id: channelId };
  }
  if (!channel.id) {
    throw new Error("native_dm_channel_missing");
  }
  const channelId = channel.id;
  for (const memberId of [recipient.id, botMemberId]) {
    await input.env.DB
      .prepare("INSERT OR IGNORE INTO thane_cli_channel_members (id, channel_id, member_id, joined_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), channelId, memberId, input.nowIso)
      .run();
  }
  const digestText = buildDigestMessage({
    taskCount: openTasks.length,
    tasks: openTasks,
    cadence: input.cadence
  });
  const messageId = crypto.randomUUID();
  await input.env.DB
    .prepare(
      `INSERT INTO thane_cli_chat_messages (
         id, workspace_id, channel_id, author_member_id, text, source, thread_root_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'chat', NULL, ?, ?)`
    )
    .bind(messageId, input.cadence.workspaceId, channelId, botMemberId, digestText, input.nowIso, input.nowIso)
    .run();
  const nextDigestAt = computeNextDigestAt({
    cadenceJson: normalizeCadenceSpec(input.cadence.cadenceJson) as unknown as Record<string, unknown>,
    timezone: normalizeTimezone(input.cadence.timezone),
    nowIso: input.nowIso,
    fromIso: input.nowIso
  });
  await input.repo.recordDigestDelivery({
    id: crypto.randomUUID(),
    organizationId: input.cadence.organizationId,
    workspaceId: input.cadence.workspaceId,
    userId: input.cadence.userId,
    externalUserId: input.cadence.externalUserId,
    deliveryChannelId: channelId,
    sourceMessageId: messageId,
    taskCount: openTasks.length,
    sentAt: input.nowIso,
    metadata: {
      cadence: input.cadence.cadenceJson,
      task_ids: openTasks.slice(0, 50).map((task) => task.id),
      digest_mode: "native_thane_chat"
    }
  });
  await input.repo.setUserNotificationCadenceDigestTimes({
    organizationId: input.cadence.organizationId,
    workspaceId: input.cadence.workspaceId,
    userId: input.cadence.userId,
    lastDigestAt: input.nowIso,
    ...(nextDigestAt ? { nextDigestAt } : {}),
    updatedAt: input.nowIso
  });
  return "sent";
}

async function resolveBotTokenForWorkspace(input: {
  env: BotEnv;
  workspaceInstallMap: Map<string, WorkspaceInstallRef>;
  workspaceId: string;
}): Promise<WorkspaceInstallRef | null> {
  const mapped = input.workspaceInstallMap.get(input.workspaceId);
  if (mapped) {
    return mapped;
  }
  if (input.env.SLACK_BOT_TOKEN) {
    return { botToken: input.env.SLACK_BOT_TOKEN };
  }
  return null;
}

async function dispatchCadenceDigest(input: {
  env: BotEnv;
  repo: D1TaskRepository;
  resolver: ConversationAccessResolver;
  workspaceInstallMap: Map<string, WorkspaceInstallRef>;
  nowIso: string;
  cadence: UserNotificationCadenceRecord;
  options: ReminderDispatchOptions;
}): Promise<"sent" | "skipped_no_tasks" | "skipped_unremindable_assignee"> {
  const readableConversationSourceIds = await input.resolver.listReadableConversationSourceIds({
    organizationId: input.cadence.organizationId,
    userId: input.cadence.userId
  });

  const assigneeIdentifiers = Array.from(
    new Set([input.cadence.externalUserId, input.cadence.userId].map((value) => value.trim()).filter(Boolean))
  );
  const taskMap = new Map<string, TaskRecord>();
  for (const assigneeId of assigneeIdentifiers) {
    const tasks = await input.repo.listOpenByAssigneeWithAcl({
      organizationId: input.cadence.organizationId,
      assigneeId,
      readableConversationSourceIds,
      allowUnscoped: true
    });
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }
  }
  const openTasks = Array.from(taskMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const timezone = normalizeTimezone(input.cadence.timezone);
  const normalizedCadence = normalizeCadenceSpec(input.cadence.cadenceJson);
  const nextDigestAt = computeNextDigestAt({
    cadenceJson: normalizedCadence as unknown as Record<string, unknown>,
    timezone,
    nowIso: input.nowIso,
    fromIso: input.nowIso
  });

  if (openTasks.length === 0 && !input.options.forceSendNoTasks) {
    await input.repo.setUserNotificationCadenceDigestTimes({
      organizationId: input.cadence.organizationId,
      workspaceId: input.cadence.workspaceId,
      userId: input.cadence.userId,
      lastDigestAt: input.cadence.lastDigestAt ?? input.nowIso,
      ...(nextDigestAt ? { nextDigestAt } : {}),
      updatedAt: input.nowIso
    });
    return "skipped_no_tasks";
  }

  const install = await resolveBotTokenForWorkspace({
    env: input.env,
    workspaceInstallMap: input.workspaceInstallMap,
    workspaceId: input.cadence.workspaceId
  });
  if (!install?.botToken) {
    throw new Error("missing_slack_bot_token");
  }

  try {
    const profile = await fetchSlackUserProfile({
      botToken: install.botToken,
      userId: input.cadence.externalUserId
    });
    const remindability = isDmRemindableForInstall({ profile, install });
    if (!remindability.remindable) {
      await input.repo.setUserNotificationCadenceDigestTimes({
        organizationId: input.cadence.organizationId,
        workspaceId: input.cadence.workspaceId,
        userId: input.cadence.userId,
        lastDigestAt: input.cadence.lastDigestAt ?? input.nowIso,
        ...(nextDigestAt ? { nextDigestAt } : {}),
        updatedAt: input.nowIso
      });
      console.info("digest_skip_unremindable_assignee", {
        organizationId: input.cadence.organizationId,
        workspaceId: input.cadence.workspaceId,
        userId: input.cadence.userId,
        externalUserId: input.cadence.externalUserId,
        reason: remindability.reason
      });
      return "skipped_unremindable_assignee";
    }
  } catch (error) {
    console.warn("digest_recipient_profile_check_failed", {
      organizationId: input.cadence.organizationId,
      workspaceId: input.cadence.workspaceId,
      userId: input.cadence.userId,
      externalUserId: input.cadence.externalUserId,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  const dm = await openSlackDirectMessage({
    botToken: install.botToken,
    userId: input.cadence.externalUserId
  });

  let digestText = buildDigestMessage({
    taskCount: openTasks.length,
    tasks: openTasks,
    cadence: input.cadence
  });

  const policy = await resolveWorkspaceBillingPolicy({
    env: input.env,
    organizationId: input.cadence.organizationId,
    workspaceId: input.cadence.workspaceId
  });
  if (shouldUseAiDigest(policy.planTier)) {
    try {
      const dmHistory = await fetchSlackConversationHistory({
        botToken: install.botToken,
        channelId: dm.channelId,
        limit: 40,
        maxPages: 1
      });
      const contextMessages = toDigestContextMessages({
        messages: dmHistory,
        recipientExternalUserId: input.cadence.externalUserId,
        ...(install.botUserId ? { botUserId: install.botUserId } : {})
      });
      const model = resolveModelForWorkspaceTier({
        env: input.env,
        planTier: policy.planTier,
        usage: "digest"
      });
      digestText = await buildAiDigestMessage({
        env: input.env,
        organizationId: input.cadence.organizationId,
        workspaceId: input.cadence.workspaceId,
        cadence: input.cadence,
        taskCount: openTasks.length,
        tasks: openTasks,
        contextMessages,
        model
      });
    } catch (error) {
      console.warn("digest_ai_generation_failed", {
        organizationId: input.cadence.organizationId,
        workspaceId: input.cadence.workspaceId,
        userId: input.cadence.userId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const posted = await postSlackMessage({
    botToken: install.botToken,
    channelId: dm.channelId,
    text: digestText
  });

  await input.repo.recordDigestDelivery({
    id: crypto.randomUUID(),
    organizationId: input.cadence.organizationId,
    workspaceId: input.cadence.workspaceId,
    userId: input.cadence.userId,
    externalUserId: input.cadence.externalUserId,
    deliveryChannelId: posted.channelId,
    sourceMessageId: posted.ts,
    taskCount: openTasks.length,
    sentAt: input.nowIso,
    metadata: {
      cadence: input.cadence.cadenceJson,
      task_ids: openTasks.slice(0, 50).map((task) => task.id),
      digest_mode: shouldUseAiDigest(policy.planTier) ? "ai" : "deterministic"
    }
  });

  await input.repo.setUserNotificationCadenceDigestTimes({
    organizationId: input.cadence.organizationId,
    workspaceId: input.cadence.workspaceId,
    userId: input.cadence.userId,
    lastDigestAt: input.nowIso,
    ...(nextDigestAt ? { nextDigestAt } : {}),
    updatedAt: input.nowIso
  });

  return "sent";
}

export async function runScheduledReminderDigests(env: BotEnv): Promise<ReminderRunStats> {
  const repo = new D1TaskRepository(env.DB);
  const resolver = new ConversationAccessResolver(env.DB);
  const installStore = new SlackInstallStore(env.DB);
  const nowIso = new Date().toISOString();
  const installs = await installStore.listWorkspaceInstalls();
  const workspaceInstallMap = new Map(installs.map((row) => [row.workspaceId, row]));

  const usersWithOpenTasks = (await repo.listUsersWithOpenTasks(1000)).filter((row) => row.platform === "slack" || row.platform === "thane_cli");

  for (const row of usersWithOpenTasks) {
    await ensureDefaultCadence({
      repo,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      externalUserId: row.externalUserId,
      platform: row.platform,
      nowIso
    });
  }

  const dueCadences = await repo.listDueNotificationCadences(nowIso, 300);

  const stats: ReminderRunStats = {
    usersWithOpenTasks: usersWithOpenTasks.length,
    dueCadences: dueCadences.length,
    messagesSent: 0,
    skippedNoTasks: 0,
    skippedUnremindable: 0,
    failures: 0
  };

  for (const cadence of dueCadences) {
    try {
      const outcome =
        cadence.platform === "slack"
          ? await dispatchCadenceDigest({
              env,
              repo,
              resolver,
              workspaceInstallMap,
              nowIso,
              cadence,
              options: { forceSendNoTasks: false }
            })
          : cadence.platform === "thane_cli"
            ? await dispatchNativeCadenceDigest({
                env,
                repo,
                nowIso,
                cadence,
                options: { forceSendNoTasks: false }
              })
            : "skipped_unremindable_assignee";
      if (outcome === "sent") {
        stats.messagesSent += 1;
      } else if (outcome === "skipped_unremindable_assignee") {
        stats.skippedUnremindable += 1;
      } else {
        stats.skippedNoTasks += 1;
      }
    } catch (error) {
      stats.failures += 1;
      console.error("digest_delivery_failed", {
        organizationId: cadence.organizationId,
        workspaceId: cadence.workspaceId,
        userId: cadence.userId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return stats;
}

export async function runWorkspaceReminderDigestsNow(input: {
  env: BotEnv;
  workspaceId: string;
  includeAllWorkspaceUsers?: boolean;
}): Promise<ReminderRunStats & { targetedUsers: number }> {
  const repo = new D1TaskRepository(input.env.DB);
  const resolver = new ConversationAccessResolver(input.env.DB);
  const installStore = new SlackInstallStore(input.env.DB);
  const nowIso = new Date().toISOString();
  const installs = await installStore.listWorkspaceInstalls();
  const workspaceInstallMap = new Map(installs.map((row) => [row.workspaceId, row]));

  const install = installs.find((row) => row.workspaceId === input.workspaceId);
  if (!install) {
    throw new Error(`workspace_not_installed:${input.workspaceId}`);
  }
  const botUserId = install.botUserId ?? null;

  const usersWithOpenTasks = (await repo.listUsersWithOpenTasks(1000)).filter(
    (row) => row.platform === "slack" && row.workspaceId === input.workspaceId
  );
  const usersFromWorkspace = input.includeAllWorkspaceUsers
    ? await repo.listWorkspaceUsers({
        organizationId: install.organizationId,
        workspaceId: input.workspaceId,
        limit: 500
      })
    : [];

  const targetMap = new Map<string, { userId: string; externalUserId: string }>();
  for (const row of usersWithOpenTasks) {
    targetMap.set(row.userId, { userId: row.userId, externalUserId: row.externalUserId });
  }
  for (const user of usersFromWorkspace) {
    targetMap.set(user.userId, { userId: user.userId, externalUserId: user.externalUserId });
  }

  const targets = Array.from(targetMap.values());
  const filteredTargets = botUserId
    ? targets.filter((target) => target.externalUserId !== botUserId)
    : targets;
  for (const target of filteredTargets) {
    await ensureDefaultCadence({
      repo,
      organizationId: install.organizationId,
      workspaceId: input.workspaceId,
      userId: target.userId,
      externalUserId: target.externalUserId,
      platform: "slack",
      nowIso
    });
  }

  const stats: ReminderRunStats & { targetedUsers: number } = {
    usersWithOpenTasks: usersWithOpenTasks.length,
    dueCadences: filteredTargets.length,
    messagesSent: 0,
    skippedNoTasks: 0,
    skippedUnremindable: 0,
    failures: 0,
    targetedUsers: filteredTargets.length
  };

  for (const target of filteredTargets) {
    try {
      const cadence = await repo.getUserNotificationCadence({
        organizationId: install.organizationId,
        workspaceId: input.workspaceId,
        userId: target.userId
      });
      if (!cadence || cadence.platform !== "slack") {
        continue;
      }
      const outcome = await dispatchCadenceDigest({
        env: input.env,
        repo,
        resolver,
        workspaceInstallMap,
        nowIso,
        cadence,
        options: { forceSendNoTasks: true }
      });
      if (outcome === "sent") {
        stats.messagesSent += 1;
      } else if (outcome === "skipped_unremindable_assignee") {
        stats.skippedUnremindable += 1;
      } else {
        stats.skippedNoTasks += 1;
      }
    } catch (error) {
      stats.failures += 1;
      console.error("workspace_digest_delivery_failed", {
        workspaceId: input.workspaceId,
        userId: target.userId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return stats;
}

export const __testables = {
  buildDigestMessage,
  shouldUseAiDigest,
  isDmRemindableForInstall,
  toDigestContextMessages,
  buildAiDigestMessage,
  dispatchNativeCadenceDigest
};
