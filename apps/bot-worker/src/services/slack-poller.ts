import { D1TaskRepository } from "@ask-thane/data";
import type { TaskRecord, TaskUrgency } from "@ask-thane/domain";
import { ConversationAccessResolver } from "./conversation-access";
import { fetchSlackConversationHistory, type SlackHistoryMessage, type SlackReaction } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface WorkspacePollTarget {
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  botToken: string;
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

function compactTitleFromMessage(text: string): string {
  const withoutMentions = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const withoutLinks = withoutMentions.replace(/<https?:[^>|]+\|?([^>]+)?>/g, "$1").trim();
  const collapsed = withoutLinks.replace(/\s+/g, " ").trim();
  const strippedLead = collapsed.replace(
    /^(please\s+|can\s+you\s+|could\s+you\s+|we\s+need\s+to\s+|need\s+to\s+)/i,
    ""
  );
  const finalTitle = strippedLead.length > 0 ? strippedLead : collapsed;
  return finalTitle.slice(0, 180);
}

function guessUrgency(text: string): TaskUrgency {
  const lower = text.toLowerCase();
  if (/\b(asap|urgent|immediately|right away|today)\b/.test(lower)) {
    return "high";
  }
  if (/\b(blocker|critical|sev1|p0)\b/.test(lower)) {
    return "critical";
  }
  if (/\b(whenever|no rush|eventually)\b/.test(lower)) {
    return "low";
  }
  return "medium";
}

function isTaskLikeRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length < 8) {
    return false;
  }

  return (
    /\b(please|can you|could you|need to|needs to|todo|to-do|follow up|ship|deploy|review|update|fix|write|prepare|send|finish|complete)\b/.test(
      lower
    ) || /\?$/.test(lower)
  );
}

function isVolunteerPrompt(text: string): boolean {
  return /\b(can someone|who can|anyone able|someone to)\b/i.test(text);
}

function chooseAssignee(input: {
  text: string;
  authorUserId: string;
  mentions: string[];
  reactions: SlackReaction[];
}): string | null {
  if (input.mentions.length > 0) {
    return input.mentions[0] ?? null;
  }

  if (isVolunteerPrompt(input.text)) {
    for (const reaction of input.reactions) {
      const name = reaction.name?.toLowerCase() ?? "";
      if (name !== "+1" && name !== "thumbsup") {
        continue;
      }

      for (const reactor of reaction.users ?? []) {
        if (reactor !== input.authorUserId) {
          return reactor;
        }
      }
    }
  }

  if (/\b(i(?:'| a)?ll|i will|i can take|i can do|i got it)\b/i.test(input.text)) {
    return input.authorUserId;
  }

  return null;
}

function inferTaskFromMessage(input: {
  workspaceId: string;
  channelId: string;
  message: SlackHistoryMessage;
  authorUserId: string;
  mentions: string[];
}): TaskRecord | null {
  const text = input.message.text?.trim() ?? "";
  if (!text || !isTaskLikeRequest(text)) {
    return null;
  }

  const assigneeUserId = chooseAssignee({
    text,
    authorUserId: input.authorUserId,
    mentions: input.mentions,
    reactions: input.message.reactions ?? []
  });

  if (!assigneeUserId) {
    return null;
  }

  const title = compactTitleFromMessage(text);
  if (!title) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    sourceMessageId: input.message.ts!,
    title,
    assignee: {
      platform: "slack",
      platformUserId: assigneeUserId
    },
    assigner: {
      platform: "slack",
      platformUserId: input.authorUserId
    },
    createdAt: input.message.ts ? asIsoFromSlackTs(input.message.ts) : new Date().toISOString(),
    urgency: guessUrgency(text),
    difficulty: "medium",
    status: "incomplete",
    confidence: 0.62,
    metadata: {
      extractor: "slack_poll_heuristic_v1",
      reactions: (input.message.reactions ?? []).map((reaction) => ({
        name: reaction.name ?? null,
        users: reaction.users ?? []
      })),
      mention_user_ids: input.mentions
    }
  };
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

async function processWorkspaceMessages(target: WorkspacePollTarget, env: BotEnv): Promise<void> {
  const repo = new D1TaskRepository(env.DB);
  const resolver = new ConversationAccessResolver(env.DB);
  const channels = await listJoinedChannels(target.botToken);

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
      }

      const alreadyTasked = await hasTaskForSourceMessage({
        db: env.DB,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        sourceMessageId: message.ts
      });

      if (!alreadyTasked) {
        const task = inferTaskFromMessage({
          workspaceId: target.workspaceId,
          channelId: channel.id,
          message,
          authorUserId: message.user,
          mentions
        });

        if (task) {
          await repo.save(task);
          await repo.performTaskAction({
            id: crypto.randomUUID(),
            organizationId: target.organizationId,
            workspaceId: target.workspaceId,
            taskId: task.id,
            actionType: "create",
            actorPlatform: "slack",
            actorId: message.user,
            sourceConversationSourceId: source.id,
            payload: {
              extractor: "slack_poll_heuristic_v1",
              message_ts: message.ts
            },
            createdAt: nowIso
          });
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
}

export async function pollSlackWorkspacesForTasks(env: BotEnv): Promise<void> {
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

  for (const target of targetsByWorkspace.values()) {
    try {
      await processWorkspaceMessages(target, env);
    } catch (error) {
      console.error("slack_poll_workspace_failed", {
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
