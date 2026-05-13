import { D1TaskRepository } from "@ask-thane/data";
import type { MessageEvent } from "@ask-thane/domain";
import { runConversationalAgentForSlackMessage } from "./agent-runtime";
import { ConversationAccessResolver } from "./conversation-access";
import { addSlackReaction, fetchSlackConversationHistory, type SlackHistoryMessage, type SlackReaction } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import { mapTaskActionTypesToSlackReactions } from "./slack-task-reactions";
import type { BotEnv } from "./task-inference";

interface WorkspacePollTarget {
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  botToken: string;
}

interface WorkspacePollStats {
  channelsScanned: number;
  messagesSeen: number;
  messagesIngested: number;
  tasksCreated: number;
  identitiesLinked: number;
}

export interface PollRunSummary {
  startedAt: string;
  finishedAt: string;
  workspacesAttempted: number;
  workspacesSucceeded: number;
  workspacesFailed: number;
  totals: WorkspacePollStats;
  workspaceResults: Array<{
    organizationId: string;
    workspaceId: string;
    ok: boolean;
    stats?: WorkspacePollStats;
    error?: string;
  }>;
}

interface SlackConversation {
  id?: string;
  is_member?: boolean;
  is_archived?: boolean;
  is_private?: boolean;
}

interface SlackConversationListResponse {
  ok?: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: {
    next_cursor?: string;
  };
}

function asIsoFromSlackTs(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

function extractMentions(text: string): string[] {
  const ids = new Set<string>();
  const regex = /<@([A-Z0-9]+)>/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text))) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }
  return Array.from(ids);
}

async function listJoinedChannels(botToken: string): Promise<Array<{ id: string; isPrivate: boolean }>> {
  const channels: Array<{ id: string; isPrivate: boolean }> = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      exclude_archived: "true",
      limit: "500",
      types: "public_channel,private_channel"
    });
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${botToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`slack_conversations_list_http_error:${response.status}`);
    }

    const payload = (await response.json()) as SlackConversationListResponse;
    if (!payload.ok) {
      throw new Error(`slack_conversations_list_error:${payload.error ?? "unknown"}`);
    }

    for (const channel of payload.channels ?? []) {
      if (!channel.id || channel.is_archived) {
        continue;
      }
      if (!channel.is_member) {
        continue;
      }

      channels.push({
        id: channel.id,
        isPrivate: Boolean(channel.is_private)
      });
    }

    cursor = payload.response_metadata?.next_cursor?.trim() || null;
  } while (cursor);

  return channels;
}

async function getPollCursor(input: {
  db: D1Database;
  organizationId: string;
  workspaceId: string;
  provider: string;
  cursorKey: string;
}): Promise<string | null> {
  const row = await input.db
    .prepare(
      `SELECT last_cursor
       FROM workspace_poll_cursors
       WHERE organization_id = ?
         AND workspace_id = ?
         AND provider = ?
         AND cursor_key = ?
       LIMIT 1`
    )
    .bind(input.organizationId, input.workspaceId, input.provider, input.cursorKey)
    .first<Record<string, unknown>>();

  return row?.last_cursor ? String(row.last_cursor) : null;
}

async function putPollCursor(input: {
  db: D1Database;
  organizationId: string;
  workspaceId: string;
  provider: string;
  cursorKey: string;
  lastCursor: string;
  nowIso: string;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO workspace_poll_cursors (
         id, organization_id, workspace_id, provider, cursor_key, last_cursor, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, workspace_id, provider, cursor_key)
       DO UPDATE SET
         last_cursor = excluded.last_cursor,
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.provider,
      input.cursorKey,
      input.lastCursor,
      input.nowIso
    )
    .run();
}

async function ensureIdentityForSlackUser(input: {
  resolver: ConversationAccessResolver;
  repo: D1TaskRepository;
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  platformUserId: string;
  nowIso: string;
}): Promise<{ userId: string }> {
  const user = await input.resolver.ensureSlackUser({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    platformUserId: input.platformUserId,
    nowIso: input.nowIso
  });

  await input.repo.resolveOrCreatePersonForIdentity({
    organizationId: input.organizationId,
    provider: "slack",
    externalWorkspaceId: input.externalWorkspaceId,
    externalUserId: input.platformUserId,
    linkedUserId: user.userId,
    confidence: 0.75,
    isVerified: false,
    nowIso: input.nowIso
  });

  return user;
}

async function hasTaskForSourceMessage(input: {
  db: D1Database;
  organizationId: string;
  workspaceId: string;
  sourceMessageId: string;
}): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT id
       FROM tasks
       WHERE organization_id = ?
         AND workspace_id = ?
         AND source_message_id = ?
       LIMIT 1`
    )
    .bind(input.organizationId, input.workspaceId, input.sourceMessageId)
    .first<Record<string, unknown>>();

  return Boolean(row?.id);
}

async function processWorkspaceMessages(target: WorkspacePollTarget, env: BotEnv): Promise<WorkspacePollStats> {
  const repo = new D1TaskRepository(env.DB);
  const resolver = new ConversationAccessResolver(env.DB);
  const channels = await listJoinedChannels(target.botToken);
  const stats: WorkspacePollStats = {
    channelsScanned: channels.length,
    messagesSeen: 0,
    messagesIngested: 0,
    tasksCreated: 0,
    identitiesLinked: 0
  };

  for (const channel of channels) {
    const nowIso = new Date().toISOString();
    const source = await resolver.upsertSlackConversationSource({
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      channelId: channel.id,
      conversationKind: channel.isPrivate ? "private_channel" : "public_channel",
      isPublic: !channel.isPrivate,
      nowIso
    });

    const cursorKey = `channel:${channel.id}`;
    const previousCursor = await getPollCursor({
      db: env.DB,
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      provider: "slack_history",
      cursorKey
    });

    const oldestTs =
      previousCursor ?? String(Math.floor(Date.now() / 1000) - 60 * 60 * 4);

    const messages = await fetchSlackConversationHistory({
      botToken: target.botToken,
      channelId: channel.id,
      oldestTs,
      maxPages: 8
    });

    let newestSeenTs: string | null = null;

    for (const message of messages) {
      if (!message.ts || !message.user || !message.text) {
        continue;
      }
      if (message.type && message.type !== "message") {
        continue;
      }
      if (message.subtype) {
        continue;
      }
      stats.messagesSeen += 1;

      newestSeenTs = message.ts;

      const providerEventId = `poll:${channel.id}:${message.ts}`;
      const ingestCreated = await repo.recordIngestEvent({
        id: crypto.randomUUID(),
        organizationId: target.organizationId,
        provider: "slack_poll",
        providerEventId,
        providerMessageId: message.ts,
        conversationSourceId: source.id,
        receivedAt: nowIso
      });

      if (!ingestCreated) {
        continue;
      }
      stats.messagesIngested += 1;

      const mentions = extractMentions(message.text);
      const participants = new Set<string>([message.user, ...mentions]);
      for (const reaction of message.reactions ?? []) {
        for (const reactor of reaction.users ?? []) {
          participants.add(reactor);
        }
      }

      for (const participant of participants) {
        await ensureIdentityForSlackUser({
          resolver,
          repo,
          organizationId: target.organizationId,
          workspaceId: target.workspaceId,
          externalWorkspaceId: target.externalWorkspaceId,
          platformUserId: participant,
          nowIso
        });
        stats.identitiesLinked += 1;
      }

      await resolver.ensureSlackConversationMembership({
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        conversationSourceId: source.id,
        platformUserId: message.user,
        nowIso
      });

      const alreadyTasked = await hasTaskForSourceMessage({
        db: env.DB,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        sourceMessageId: message.ts
      });

      if (!alreadyTasked) {
        const event: MessageEvent = {
          workspaceId: target.workspaceId,
          channelId: channel.id,
          messageId: message.ts,
          text: message.text,
          author: {
            platform: "slack",
            platformUserId: message.user
          },
          occurredAt: asIsoFromSlackTs(message.ts)
        };

        const agentRun = await runConversationalAgentForSlackMessage({
          env,
          organizationId: target.organizationId,
          workspaceId: target.workspaceId,
          externalWorkspaceId: target.externalWorkspaceId,
          conversationSourceId: source.id,
          event
        });
        stats.tasksCreated += agentRun.createdTaskIds.length;

        const reactions = mapTaskActionTypesToSlackReactions(agentRun.taskActionTypes);
        for (const reaction of reactions) {
          try {
            await addSlackReaction({
              botToken: target.botToken,
              channelId: channel.id,
              messageTs: message.ts,
              reaction
            });
          } catch (error) {
            console.warn("slack_poll_add_reaction_failed", {
              workspaceId: target.workspaceId,
              channelId: channel.id,
              messageTs: message.ts,
              reaction,
              reason: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      await repo.markIngestEventProcessed(target.organizationId, "slack_poll", providerEventId, nowIso);
    }

    if (newestSeenTs) {
      await putPollCursor({
        db: env.DB,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        provider: "slack_history",
        cursorKey,
        lastCursor: newestSeenTs,
        nowIso: new Date().toISOString()
      });
    }
  }

  return stats;
}

export async function pollSlackWorkspacesForTasks(env: BotEnv): Promise<PollRunSummary> {
  const startedAt = new Date().toISOString();
  const installs = new SlackInstallStore(env.DB);
  const resolver = new ConversationAccessResolver(env.DB);
  const targetsByWorkspace = new Map<string, WorkspacePollTarget>();

  const workspaceInstalls = await installs.listWorkspaceInstalls();
  for (const install of workspaceInstalls) {
    targetsByWorkspace.set(install.workspaceId, {
      organizationId: install.organizationId,
      workspaceId: install.workspaceId,
      externalWorkspaceId: install.externalWorkspaceId,
      botToken: install.botToken
    });
  }

  if (env.SLACK_BOT_TOKEN) {
    const slackWorkspaces = await resolver.listSlackWorkspaces();
    for (const workspace of slackWorkspaces) {
      if (targetsByWorkspace.has(workspace.workspaceId)) {
        continue;
      }

      targetsByWorkspace.set(workspace.workspaceId, {
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        externalWorkspaceId: workspace.externalWorkspaceId,
        botToken: env.SLACK_BOT_TOKEN
      });
    }
  }

  const workspaceResults: PollRunSummary["workspaceResults"] = [];
  const totals: WorkspacePollStats = {
    channelsScanned: 0,
    messagesSeen: 0,
    messagesIngested: 0,
    tasksCreated: 0,
    identitiesLinked: 0
  };

  for (const target of targetsByWorkspace.values()) {
    try {
      const stats = await processWorkspaceMessages(target, env);
      workspaceResults.push({
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        ok: true,
        stats
      });
      totals.channelsScanned += stats.channelsScanned;
      totals.messagesSeen += stats.messagesSeen;
      totals.messagesIngested += stats.messagesIngested;
      totals.tasksCreated += stats.tasksCreated;
      totals.identitiesLinked += stats.identitiesLinked;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("slack_poll_workspace_failed", {
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        reason
      });
      workspaceResults.push({
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        ok: false,
        error: reason
      });
    }
  }

  const workspacesSucceeded = workspaceResults.filter((result) => result.ok).length;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    workspacesAttempted: workspaceResults.length,
    workspacesSucceeded,
    workspacesFailed: workspaceResults.length - workspacesSucceeded,
    totals,
    workspaceResults
  };
}
