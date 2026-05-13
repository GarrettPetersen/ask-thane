import { D1TaskRepository, type UserNotificationCadenceRecord } from "@ask-thane/data";
import type { TaskRecord } from "@ask-thane/domain";
import { ConversationAccessResolver } from "./conversation-access";
import { computeNextDigestAt, defaultCadenceSpec, normalizeCadenceSpec, normalizeTimezone } from "./notification-cadence";
import { openSlackDirectMessage, postSlackMessage } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface ReminderRunStats {
  usersWithOpenTasks: number;
  dueCadences: number;
  messagesSent: number;
  skippedNoTasks: number;
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
  parts.push(`asked by <@${task.assigner.platformUserId}>`);
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

async function ensureDefaultCadence(input: {
  repo: D1TaskRepository;
  organizationId: string;
  workspaceId: string;
  userId: string;
  externalUserId: string;
  platform: "slack";
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

async function resolveBotTokenForWorkspace(input: {
  env: BotEnv;
  workspaceTokenMap: Map<string, string>;
  workspaceId: string;
}): Promise<string | null> {
  const mapped = input.workspaceTokenMap.get(input.workspaceId);
  if (mapped) {
    return mapped;
  }
  return input.env.SLACK_BOT_TOKEN ?? null;
}

async function dispatchCadenceDigest(input: {
  env: BotEnv;
  repo: D1TaskRepository;
  resolver: ConversationAccessResolver;
  workspaceTokenMap: Map<string, string>;
  nowIso: string;
  cadence: UserNotificationCadenceRecord;
  options: ReminderDispatchOptions;
}): Promise<"sent" | "skipped_no_tasks"> {
  const readableConversationSourceIds = await input.resolver.listReadableConversationSourceIds({
    organizationId: input.cadence.organizationId,
    userId: input.cadence.userId
  });

  const openTasks = await input.repo.listOpenByAssigneeWithAcl({
    organizationId: input.cadence.organizationId,
    assigneeId: input.cadence.externalUserId,
    readableConversationSourceIds,
    allowUnscoped: true
  });

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

  const botToken = await resolveBotTokenForWorkspace({
    env: input.env,
    workspaceTokenMap: input.workspaceTokenMap,
    workspaceId: input.cadence.workspaceId
  });
  if (!botToken) {
    throw new Error("missing_slack_bot_token");
  }

  const dm = await openSlackDirectMessage({
    botToken,
    userId: input.cadence.externalUserId
  });

  const digestText = buildDigestMessage({
    taskCount: openTasks.length,
    tasks: openTasks,
    cadence: input.cadence
  });

  const posted = await postSlackMessage({
    botToken,
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
      task_ids: openTasks.slice(0, 50).map((task) => task.id)
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
  const workspaceTokenMap = new Map(installs.map((row) => [row.workspaceId, row.botToken]));

  const usersWithOpenTasks = (await repo.listUsersWithOpenTasks(1000)).filter((row) => row.platform === "slack");

  for (const row of usersWithOpenTasks) {
    await ensureDefaultCadence({
      repo,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      externalUserId: row.externalUserId,
      platform: "slack",
      nowIso
    });
  }

  const dueCadences = await repo.listDueNotificationCadences(nowIso, 300);

  const stats: ReminderRunStats = {
    usersWithOpenTasks: usersWithOpenTasks.length,
    dueCadences: dueCadences.length,
    messagesSent: 0,
    skippedNoTasks: 0,
    failures: 0
  };

  for (const cadence of dueCadences) {
    try {
      if (cadence.platform !== "slack") {
        continue;
      }
      const outcome = await dispatchCadenceDigest({
        env,
        repo,
        resolver,
        workspaceTokenMap,
        nowIso,
        cadence,
        options: { forceSendNoTasks: false }
      });
      if (outcome === "sent") {
        stats.messagesSent += 1;
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
  const workspaceTokenMap = new Map(installs.map((row) => [row.workspaceId, row.botToken]));

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
        workspaceTokenMap,
        nowIso,
        cadence,
        options: { forceSendNoTasks: true }
      });
      if (outcome === "sent") {
        stats.messagesSent += 1;
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
