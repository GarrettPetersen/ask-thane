import { D1TaskRepository } from "@ask-thane/data";
import { healthcheck } from "./routes/health";
import { handleSlackEvents } from "./routes/slack-events";
import { handleSlackInstallStart, handleSlackOAuthCallback } from "./routes/slack-oauth";
import { isAdminAuthorized } from "./services/admin-auth";
import {
  aggregateDailyUsage,
  getBillingPreviewStatus,
  getOpenAiCostReconciliationStatus,
  getWorkspaceBillingPreview,
  getUsageStatus,
  syncOpenAiCostReconciliation,
  syncUsageToStripe
} from "./services/billing-usage";
import { ConversationAccessResolver } from "./services/conversation-access";
import { runEvalReplay } from "./services/eval-harness";
import { runScheduledFollowUpJobs } from "./services/follow-up-jobs";
import { replayUnprocessedSlackIngestEvents } from "./services/ingest-replay";
import { runConversationalAgentForThaneChatMessage } from "./services/agent-runtime";
import { getSlackInstallDiagnostics } from "./services/onboarding-diagnostics";
import { getOpsSummary, getWorkspaceOpsSummary } from "./services/ops-dashboard";
import { runScheduledReminderDigests, runWorkspaceReminderDigestsNow } from "./services/reminder-digests";
import { pollSlackWorkspacesForTasks } from "./services/slack-poller";
import { SlackInstallStore } from "./services/slack-install-store";
import { mapTaskActionTypesToThaneChatReactions } from "./services/slack-task-reactions";
import type { BotEnv } from "./services/task-inference";

function getBuildInfo(env: BotEnv) {
  return {
    ok: true,
    service: "ask-thane-bot",
    environment: env.BUILD_ENV ?? "unknown",
    gitSha: env.BUILD_GIT_SHA ?? "unknown",
    deployedAt: env.BUILD_DEPLOYED_AT ?? "unknown"
  };
}

async function sendReminders(env: BotEnv): Promise<void> {
  await runScheduledReminderDigests(env);
}

function isSlackAuthError(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes("invalid_auth") || reason.includes("not_authed");
}

async function reconcileSlackMemberships(env: BotEnv): Promise<void> {
  const resolver = new ConversationAccessResolver(env.DB);
  const installs = new SlackInstallStore(env.DB);
  const workspaceInstalls = await installs.listWorkspaceInstalls();

  for (const workspace of workspaceInstalls) {
    try {
      await resolver.reconcileSlackConversationMemberships({
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        botToken: workspace.botToken
      });
    } catch (error) {
      if (isSlackAuthError(error) && env.SLACK_BOT_TOKEN && env.SLACK_BOT_TOKEN !== workspace.botToken) {
        try {
          await resolver.reconcileSlackConversationMemberships({
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            botToken: env.SLACK_BOT_TOKEN
          });
          continue;
        } catch (retryError) {
          console.warn("reconcile_memberships_failed", {
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            reason: retryError instanceof Error ? retryError.message : String(retryError)
          });
          continue;
        }
      }
      console.warn("reconcile_memberships_failed", {
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!env.SLACK_BOT_TOKEN) {
    return;
  }

  const legacyWorkspaces = await resolver.listSlackWorkspaces();
  for (const workspace of legacyWorkspaces) {
    const alreadyInstalled = workspaceInstalls.some(
      (install) => install.organizationId === workspace.organizationId && install.workspaceId === workspace.workspaceId
    );
    if (alreadyInstalled) {
      continue;
    }

    try {
      await resolver.reconcileSlackConversationMemberships({
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        botToken: env.SLACK_BOT_TOKEN
      });
    } catch (error) {
      console.warn("reconcile_memberships_failed", {
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function runSlackPollWithMembershipRefresh(env: BotEnv) {
  await reconcileSlackMemberships(env);
  return pollSlackWorkspacesForTasks(env);
}

async function requireAdmin(request: Request, env: BotEnv): Promise<Response | null> {
  if (await isAdminAuthorized(request, env)) {
    return null;
  }
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function requireInternalBearer(request: Request, env: BotEnv): Response | null {
  const expected = env.INTERNAL_API_BEARER_TOKEN?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || actual !== expected) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function parseJsonBody<T>(request: Request): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    const payload = (await request.json()) as T;
    return { ok: true, value: payload };
  } catch {
    return { ok: false, response: Response.json({ ok: false, error: "invalid_json_body" }, { status: 400 }) };
  }
}

interface ThaneChatWebhookRow {
  id: string;
  workspace_id: string;
  name: string;
  signing_secret: string;
  bot_member_id: string;
  status: string;
}

interface ThaneChatWebhookPayload {
  id?: string;
  type?: string;
  workspaceId?: string;
  channelId?: string;
  message?: {
    id?: string;
    workspaceId?: string;
    channelId?: string;
    authorId?: string;
    authorHandle?: string;
    authorDisplayName?: string;
    text?: string;
    source?: string;
    threadRootId?: string;
    createdAt?: string;
  };
}

interface ThaneChatChannelBridge {
  organizationId: string;
  workspaceId: string;
  conversationSourceId: string;
  channelId: string;
  channelKind: string;
}

interface ThaneChatMemberRow {
  id: string;
  account_id: string;
  email: string;
  display_name: string | null;
  handle: string;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function verifyThaneChatWebhookSignature(input: {
  request: Request;
  signingSecret: string;
  rawBody: string;
}): Promise<boolean> {
  const timestamp = input.request.headers.get("x-thane-timestamp")?.trim() ?? "";
  const signature = input.request.headers.get("x-thane-signature")?.trim() ?? "";
  if (!timestamp || !signature) {
    return false;
  }
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return false;
  }
  const expected = `v1=${await hmacSha256Hex(`${timestamp}.${input.rawBody}`, input.signingSecret)}`;
  return timingSafeEqual(signature, expected);
}

function coreOrganizationIdForThaneChatWorkspace(workspaceId: string): string {
  const suffix = workspaceId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "workspace";
  return `org_thane_${suffix}`;
}

function coreOrganizationSlugForThaneChatWorkspace(workspaceId: string): string {
  const suffix = workspaceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "workspace";
  return `thane-${suffix}`;
}

function nativeConversationKind(channel: { kind: string; visibility: string }): string {
  if (channel.kind === "dm") {
    return "dm";
  }
  return channel.visibility === "private" ? "private_channel" : "public_channel";
}

async function ensureNativeAgentUser(env: BotEnv, input: {
  organizationId: string;
  workspaceId: string;
  member: ThaneChatMemberRow;
}): Promise<string> {
  const existing = await env.DB
    .prepare(
      `SELECT id
       FROM users
       WHERE organization_id = ?
         AND workspace_id = ?
         AND platform = 'thane_cli'
         AND external_user_id = ?
       LIMIT 1`
    )
    .bind(input.organizationId, input.workspaceId, input.member.email)
    .first<{ id?: string }>();
  const nowIso = new Date().toISOString();
  if (existing?.id) {
    await env.DB
      .prepare("UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), updated_at = ? WHERE id = ?")
      .bind(input.member.display_name ?? null, input.member.email || null, nowIso, existing.id)
      .run();
    return existing.id;
  }
  const userId = `usr_thane_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB
    .prepare(
      `INSERT INTO users (
         id, organization_id, workspace_id, platform, external_user_id,
         display_name, email, role, created_at, updated_at
       ) VALUES (?, ?, ?, 'thane_cli', ?, ?, ?, 'member', ?, ?)`
    )
    .bind(
      userId,
      input.organizationId,
      input.workspaceId,
      input.member.email,
      input.member.display_name ?? input.member.handle,
      input.member.email || null,
      nowIso,
      nowIso
    )
    .run();
  return userId;
}

async function upsertNativeConversationMembership(env: BotEnv, input: {
  organizationId: string;
  workspaceId: string;
  conversationSourceId: string;
  userId: string;
  nowIso: string;
}): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO conversation_memberships (
         id, organization_id, workspace_id, conversation_source_id, user_id,
         role, is_active, version, synced_at
       ) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
       ON CONFLICT(conversation_source_id, user_id)
       DO UPDATE SET is_active = 1, version = excluded.version, synced_at = excluded.synced_at`
    )
    .bind(
      crypto.randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.conversationSourceId,
      input.userId,
      input.nowIso,
      input.nowIso
    )
    .run();
}

async function ensureThaneChatAgentBridge(env: BotEnv, input: {
  workspaceId: string;
  channelId: string;
  authorMemberId: string;
  botMemberId: string;
}): Promise<ThaneChatChannelBridge> {
  const workspace = await env.DB
    .prepare(
      `SELECT id, workspace_slug, workspace_name
       FROM thane_cli_workspaces
       WHERE id = ?
       LIMIT 1`
    )
    .bind(input.workspaceId)
    .first<{ id?: string; workspace_slug?: string; workspace_name?: string | null }>();
  const channel = await env.DB
    .prepare(
      `SELECT id, kind, visibility
       FROM thane_cli_channels
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.channelId)
    .first<{ id?: string; kind?: string; visibility?: string }>();
  if (!workspace?.id || !channel?.id || !channel.kind || !channel.visibility) {
    throw new Error("thane_chat_workspace_or_channel_not_found");
  }

  const organizationId = coreOrganizationIdForThaneChatWorkspace(workspace.id);
  const workspaceName = workspace.workspace_name?.trim() || workspace.workspace_slug || workspace.id;
  const nowIso = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO organizations (id, slug, name, plan_tier, created_at, updated_at)
       VALUES (?, ?, ?, 'free', ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
    )
    .bind(organizationId, coreOrganizationSlugForThaneChatWorkspace(workspace.id), workspaceName, nowIso, nowIso)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO workspaces (
         id, organization_id, platform, external_workspace_id, name, plan_tier, created_at, updated_at
       ) VALUES (?, ?, 'thane_cli', ?, ?, 'free', ?, ?)
       ON CONFLICT(platform, external_workspace_id) DO UPDATE SET
         organization_id = excluded.organization_id,
         name = excluded.name,
         updated_at = excluded.updated_at`
    )
    .bind(workspace.id, organizationId, workspace.id, workspaceName, nowIso, nowIso)
    .run();
  const conversationKind = nativeConversationKind({ kind: channel.kind, visibility: channel.visibility });
  await env.DB
    .prepare(
      `INSERT INTO conversation_sources (
         id, organization_id, workspace_id, provider, provider_conversation_id,
         conversation_kind, is_public, visibility_version, created_at, updated_at
       ) VALUES (?, ?, ?, 'thane_cli', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, provider, provider_conversation_id)
       DO UPDATE SET
         workspace_id = excluded.workspace_id,
         conversation_kind = excluded.conversation_kind,
         is_public = excluded.is_public,
         visibility_version = excluded.visibility_version,
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      organizationId,
      workspace.id,
      channel.id,
      conversationKind,
      channel.visibility === "public" ? 1 : 0,
      nowIso,
      nowIso,
      nowIso
    )
    .run();
  const source = await env.DB
    .prepare(
      `SELECT id
       FROM conversation_sources
       WHERE organization_id = ? AND provider = 'thane_cli' AND provider_conversation_id = ?
       LIMIT 1`
    )
    .bind(organizationId, channel.id)
    .first<{ id?: string }>();
  if (!source?.id) {
    throw new Error("thane_chat_conversation_source_not_found");
  }

  const membersResult = await env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle
       FROM thane_cli_workspace_members
       WHERE workspace_id = ? AND left_at IS NULL
       LIMIT 250`
    )
    .bind(workspace.id)
    .all<ThaneChatMemberRow>();
  const userIdByMemberId = new Map<string, string>();
  for (const member of membersResult.results ?? []) {
    const userId = await ensureNativeAgentUser(env, {
      organizationId,
      workspaceId: workspace.id,
      member
    });
    userIdByMemberId.set(member.id, userId);
  }

  const channelMemberships = await env.DB
    .prepare(
      `SELECT member_id
       FROM thane_cli_channel_members
       WHERE channel_id = ? AND left_at IS NULL`
    )
    .bind(channel.id)
    .all<{ member_id: string }>();
  const activeMemberIds = new Set((channelMemberships.results ?? []).map((row) => row.member_id));
  activeMemberIds.add(input.authorMemberId);
  activeMemberIds.add(input.botMemberId);
  for (const memberId of activeMemberIds) {
    const userId = userIdByMemberId.get(memberId);
    if (!userId) {
      continue;
    }
    await upsertNativeConversationMembership(env, {
      organizationId,
      workspaceId: workspace.id,
      conversationSourceId: source.id,
      userId,
      nowIso
    });
  }

  return {
    organizationId,
    workspaceId: workspace.id,
    conversationSourceId: source.id,
    channelId: channel.id,
    channelKind: channel.kind
  };
}

function shouldRespondToThaneChatWebhookMessage(input: {
  text: string;
  channelKind: string;
}): boolean {
  if (input.channelKind === "dm") {
    return true;
  }
  return /(^|[^a-z0-9._-])@thane([^a-z0-9._-]|$)/i.test(input.text);
}

async function addNativeThaneChatReaction(input: {
  env: BotEnv;
  messageId: string;
  memberId: string;
  emoji: string;
  createdAt?: string;
}): Promise<void> {
  await input.env.DB
    .prepare(
      `INSERT OR IGNORE INTO thane_cli_message_reactions (id, message_id, member_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), input.messageId, input.memberId, input.emoji, input.createdAt ?? new Date().toISOString())
    .run();
}

async function handleThaneChatWebhookEvent(request: Request, env: BotEnv): Promise<Response> {
  const webhookId = request.headers.get("x-thane-webhook-id")?.trim() ?? "";
  if (!webhookId) {
    return Response.json({ ok: false, error: "missing_webhook_id" }, { status: 401 });
  }
  const webhook = await env.DB
    .prepare(
      `SELECT id, workspace_id, name, signing_secret, bot_member_id, status
       FROM thane_cli_webhooks
       WHERE id = ? AND status = 'active'
       LIMIT 1`
    )
    .bind(webhookId)
    .first<ThaneChatWebhookRow>();
  if (!webhook?.id) {
    return Response.json({ ok: false, error: "unknown_webhook" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyThaneChatWebhookSignature({ request, signingSecret: webhook.signing_secret, rawBody }))) {
    return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }
  let payload: ThaneChatWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ThaneChatWebhookPayload;
  } catch {
    return Response.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }
  const message = payload.message;
  if (
    payload.type !== "message.created" ||
    !payload.workspaceId ||
    !payload.channelId ||
    !message?.id ||
    !message.authorId ||
    !message.text ||
    webhook.workspace_id !== payload.workspaceId
  ) {
    return Response.json({ ok: false, error: "invalid_webhook_payload" }, { status: 400 });
  }
  if (message.authorId === webhook.bot_member_id) {
    return Response.json({ ok: true, ignored: true, reason: "self_message" });
  }
  const author = await env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle
       FROM thane_cli_workspace_members
       WHERE workspace_id = ? AND id = ? AND left_at IS NULL
       LIMIT 1`
    )
    .bind(webhook.workspace_id, message.authorId)
    .first<ThaneChatMemberRow>();
  if (!author?.id) {
    return Response.json({ ok: false, error: "author_not_found" }, { status: 404 });
  }

  const bridge = await ensureThaneChatAgentBridge(env, {
    workspaceId: webhook.workspace_id,
    channelId: payload.channelId,
    authorMemberId: author.id,
    botMemberId: webhook.bot_member_id
  });
  const shouldRespond = shouldRespondToThaneChatWebhookMessage({
    text: message.text,
    channelKind: bridge.channelKind
  });
  const authorDisplayName = author.display_name ?? message.authorDisplayName;
  const agentRun = await runConversationalAgentForThaneChatMessage({
    env,
    organizationId: bridge.organizationId,
    workspaceId: bridge.workspaceId,
    conversationSourceId: bridge.conversationSourceId,
    channelId: bridge.channelId,
    authorExternalUserId: author.email,
    authorEmail: author.email,
    ...(authorDisplayName ? { authorDisplayName } : {}),
    messageId: message.id,
    text: message.text,
    ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
    occurredAt: message.createdAt ?? new Date().toISOString(),
    interactionMode: shouldRespond ? "dm_reply" : "passive_ingest"
  });
  const reactionEmojis = mapTaskActionTypesToThaneChatReactions(agentRun.taskActionTypes);
  for (const emoji of reactionEmojis) {
    await addNativeThaneChatReaction({
      env,
      messageId: message.id,
      memberId: webhook.bot_member_id,
      emoji,
      createdAt: new Date().toISOString()
    });
  }
  let replyMessageId: string | undefined;
  if (shouldRespond && agentRun.replyText?.trim()) {
    replyMessageId = await postNativeAskThaneReply({
      env,
      workspaceId: bridge.workspaceId,
      channelId: bridge.channelId,
      text: agentRun.replyText.trim(),
      threadRootId: message.threadRootId ?? message.id
    });
  }
  const processedAt = new Date().toISOString();
  await env.DB
    .prepare("UPDATE thane_cli_ask_thane_integrations SET last_event_at = ?, updated_at = ? WHERE workspace_id = ? AND enabled = 1")
    .bind(processedAt, processedAt, webhook.workspace_id)
    .run();
  return Response.json({
    ok: true,
    usedTools: agentRun.usedTools,
    createdTaskIds: agentRun.createdTaskIds,
    updatedTaskIds: agentRun.updatedTaskIds,
    taskActionTypes: agentRun.taskActionTypes,
    eventTypes: agentRun.eventTypes,
    reactions: reactionEmojis,
    ...(agentRun.finalSummary ? { finalSummary: agentRun.finalSummary } : {}),
    ...(replyMessageId ? { reply: { messageId: replyMessageId, text: agentRun.replyText } } : {})
  });
}

async function nativeAskThaneIntegrationEnabled(env: BotEnv, workspaceId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT enabled FROM thane_cli_ask_thane_integrations WHERE workspace_id = ? LIMIT 1")
    .bind(workspaceId)
    .first<{ enabled?: number | string | null }>();
  return Number(row?.enabled ?? 0) === 1;
}

async function ensureNativeAskThaneMember(env: BotEnv, workspaceId: string): Promise<string> {
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

async function postNativeAskThaneReply(input: {
  env: BotEnv;
  workspaceId: string;
  channelId: string;
  text: string;
  threadRootId?: string | null;
}): Promise<string> {
  const botMemberId = await ensureNativeAskThaneMember(input.env, input.workspaceId);
  const nowIso = new Date().toISOString();
  const messageId = crypto.randomUUID();
  await input.env.DB
    .prepare(
      `INSERT INTO thane_cli_chat_messages (
         id, workspace_id, channel_id, author_member_id, text, source, origin, thread_root_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'terminal', 'webhook', ?, ?, ?)`
    )
    .bind(messageId, input.workspaceId, input.channelId, botMemberId, input.text, input.threadRootId ?? null, nowIso, nowIso)
    .run();
  return messageId;
}

async function getPollStatus(env: BotEnv): Promise<Record<string, unknown>> {
  const recentIngest = await env.DB
    .prepare(
      `SELECT organization_id, provider_event_id, provider_message_id, conversation_source_id, received_at, processed_at
       FROM ingest_events
       WHERE provider = 'slack_poll'
       ORDER BY received_at DESC
       LIMIT 25`
    )
    .all<Record<string, unknown>>();

  const recentCursors = await env.DB
    .prepare(
      `SELECT organization_id, workspace_id, cursor_key, last_cursor, updated_at
       FROM workspace_poll_cursors
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all<Record<string, unknown>>();

  const recentTasks = await env.DB
    .prepare(
      `SELECT organization_id, workspace_id, id, title, assignee_id, created_at
       FROM tasks
       WHERE source_message_id IN (
         SELECT provider_message_id
         FROM ingest_events
         WHERE provider = 'slack_poll'
       )
       ORDER BY created_at DESC
       LIMIT 25`
    )
    .all<Record<string, unknown>>();

  return {
    ok: true,
    backlog: {
      unprocessedSlackEvents:
        Number(
          (
            await env.DB
              .prepare(`SELECT COUNT(*) AS count FROM ingest_events WHERE provider = 'slack' AND processed_at IS NULL`)
              .first<Record<string, unknown>>()
          )?.count ?? 0
        ),
      unprocessedSlackPollEvents:
        Number(
          (
            await env.DB
              .prepare(`SELECT COUNT(*) AS count FROM ingest_events WHERE provider = 'slack_poll' AND processed_at IS NULL`)
              .first<Record<string, unknown>>()
          )?.count ?? 0
        )
    },
    recentIngestEvents: recentIngest.results ?? [],
    recentPollCursors: recentCursors.results ?? [],
    recentHeuristicTasks: recentTasks.results ?? []
  };
}

async function getDigestStatus(env: BotEnv): Promise<Record<string, unknown>> {
  const recentCadences = await env.DB
    .prepare(
      `SELECT organization_id, workspace_id, user_id, external_user_id, timezone, cadence_summary, next_digest_at, last_digest_at, updated_at
       FROM user_notification_cadences
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all<Record<string, unknown>>();

  const recentDigests = await env.DB
    .prepare(
      `SELECT organization_id, workspace_id, user_id, external_user_id, delivery_channel_id, source_message_id, task_count, sent_at
       FROM digest_deliveries
       ORDER BY sent_at DESC
       LIMIT 50`
    )
    .all<Record<string, unknown>>();

  return {
    ok: true,
    recentCadences: recentCadences.results ?? [],
    recentDigestDeliveries: recentDigests.results ?? []
  };
}

async function getFollowUpStatus(env: BotEnv): Promise<Record<string, unknown>> {
  const repo = new D1TaskRepository(env.DB);
  const jobs = await repo.listRecentFollowUpJobs(50);
  return {
    ok: true,
    recentFollowUpJobs: jobs
  };
}

export default {
  async fetch(request: Request, env: BotEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return healthcheck();
    }

    if (pathname === "/build-info") {
      return Response.json(getBuildInfo(env), { status: 200 });
    }

    if (pathname === "/webhooks/slack/events" && request.method === "POST") {
      return handleSlackEvents(request, env, ctx);
    }

    if (pathname === "/webhooks/thane-chat/events" && request.method === "POST") {
      return handleThaneChatWebhookEvent(request, env);
    }

    if (pathname === "/slack/install" && request.method === "GET") {
      return handleSlackInstallStart(request, env);
    }

    if (pathname === "/slack/oauth/callback" && request.method === "GET") {
      return handleSlackOAuthCallback(request, env);
    }

    if (pathname === "/internal/thane-chat/agent-message" && request.method === "POST") {
      const unauthorized = requireInternalBearer(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const parsed = await parseJsonBody<{
        organizationId?: string;
        workspaceId?: string;
        conversationSourceId?: string;
        channelId?: string;
        authorExternalUserId?: string;
        authorEmail?: string;
        authorDisplayName?: string;
        messageId?: string;
        text?: string;
        threadRootId?: string | null;
        shouldRespond?: boolean;
        occurredAt?: string;
      }>(request);
      if (!parsed.ok) {
        return parsed.response;
      }
      const payload = parsed.value;
      if (
        !payload.organizationId ||
        !payload.workspaceId ||
        !payload.conversationSourceId ||
        !payload.channelId ||
        !payload.authorExternalUserId ||
        !payload.messageId ||
        !payload.text
      ) {
        return Response.json({ ok: false, error: "missing_native_agent_fields" }, { status: 400 });
      }
      if (!(await nativeAskThaneIntegrationEnabled(env, payload.workspaceId))) {
        return Response.json({ ok: false, error: "ask_thane_not_enabled" }, { status: 403 });
      }
      const agentRun = await runConversationalAgentForThaneChatMessage({
        env,
        organizationId: payload.organizationId,
        workspaceId: payload.workspaceId,
        conversationSourceId: payload.conversationSourceId,
        channelId: payload.channelId,
        authorExternalUserId: payload.authorExternalUserId,
        ...(payload.authorEmail ? { authorEmail: payload.authorEmail } : {}),
        ...(payload.authorDisplayName ? { authorDisplayName: payload.authorDisplayName } : {}),
        messageId: payload.messageId,
        text: payload.text,
        ...(payload.threadRootId ? { threadRootId: payload.threadRootId } : {}),
        ...(payload.occurredAt ? { occurredAt: payload.occurredAt } : {}),
        interactionMode: payload.shouldRespond ? "dm_reply" : "passive_ingest"
      });
      let replyMessageId: string | undefined;
      if (payload.shouldRespond && agentRun.replyText?.trim()) {
        replyMessageId = await postNativeAskThaneReply({
          env,
          workspaceId: payload.workspaceId,
          channelId: payload.channelId,
          text: agentRun.replyText.trim(),
          threadRootId: payload.threadRootId ?? payload.messageId
        });
      }
      return Response.json({
        ok: true,
        usedTools: agentRun.usedTools,
        createdTaskIds: agentRun.createdTaskIds,
        updatedTaskIds: agentRun.updatedTaskIds,
        taskActionTypes: agentRun.taskActionTypes,
        eventTypes: agentRun.eventTypes,
        ...(agentRun.finalSummary ? { finalSummary: agentRun.finalSummary } : {}),
        ...(replyMessageId ? { reply: { messageId: replyMessageId, text: agentRun.replyText } } : {})
      });
    }

    if (pathname === "/admin/poll/run" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const summary = await runSlackPollWithMembershipRefresh(env);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/ingest/replay" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      let payload: { limit?: number } = {};
      try {
        payload = (await request.json()) as { limit?: number };
      } catch {
        payload = {};
      }
      const summary = await replayUnprocessedSlackIngestEvents(env, payload.limit);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/poll/status" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const status = await getPollStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/reminders/run" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const summary = await runScheduledReminderDigests(env);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/reminders/status" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const status = await getDigestStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/reminders/run-workspace" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const parsed = await parseJsonBody<{ workspaceId?: string; includeAllWorkspaceUsers?: boolean }>(request);
      if (!parsed.ok) {
        return parsed.response;
      }
      const payload = parsed.value;

      const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";
      if (!workspaceId) {
        return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
      }

      const summary = await runWorkspaceReminderDigestsNow({
        env,
        workspaceId,
        includeAllWorkspaceUsers: payload.includeAllWorkspaceUsers ?? false
      });
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/followups/run" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const summary = await runScheduledFollowUpJobs(env);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/followups/status" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const status = await getFollowUpStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/ops/summary" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const summary = await getOpsSummary(env);
      return Response.json(summary, { status: 200 });
    }

    if (pathname === "/admin/ops/workspace" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
      if (!workspaceId) {
        return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
      }
      const summary = await getWorkspaceOpsSummary(env, workspaceId);
      return Response.json(summary, { status: 200 });
    }

    if (pathname === "/admin/usage/aggregate" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const parsed = await parseJsonBody<{ usageDate?: string }>(request);
      if (!parsed.ok) {
        return parsed.response;
      }
      const summary = await aggregateDailyUsage(env, parsed.value.usageDate);
      return Response.json(summary, { status: 200 });
    }

    if (pathname === "/admin/usage/sync-stripe" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const parsed = await parseJsonBody<{ usageDate?: string }>(request);
      if (!parsed.ok) {
        return parsed.response;
      }
      const summary = await syncUsageToStripe(env, parsed.value.usageDate);
      return Response.json(summary, { status: (summary as { ok?: boolean }).ok ? 200 : 400 });
    }

    if (pathname === "/admin/usage/reconcile-openai" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const parsed = await parseJsonBody<{ usageDate?: string }>(request);
      if (!parsed.ok) {
        return parsed.response;
      }
      const summary = await syncOpenAiCostReconciliation(env, parsed.value.usageDate);
      return Response.json(summary, { status: (summary as { ok?: boolean }).ok ? 200 : 400 });
    }

    if (pathname === "/admin/usage/reconcile-status" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const status = await getOpenAiCostReconciliationStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/usage/billing-preview" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
      const month = url.searchParams.get("month")?.trim() ?? undefined;
      if (!workspaceId) {
        return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
      }

      const ws = await env.DB
        .prepare(
          `SELECT organization_id
           FROM workspaces
           WHERE id = ?
           LIMIT 1`
        )
        .bind(workspaceId)
        .first<Record<string, unknown>>();
      if (!ws?.organization_id) {
        return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
      }

      const preview = await getWorkspaceBillingPreview({
        env,
        organizationId: String(ws.organization_id),
        workspaceId,
        ...(month ? { month } : {})
      });
      return Response.json(preview, { status: 200 });
    }

    if (pathname === "/admin/usage/billing-preview-status" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const month = url.searchParams.get("month")?.trim() ?? undefined;
      const status = await getBillingPreviewStatus(env, month);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/usage/status" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const status = await getUsageStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/evals/replay" && request.method === "POST") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const parsed = await parseJsonBody<{
        workspaceId?: string;
        externalWorkspaceId?: string;
        organizationId?: string;
        cases?: Array<{
          id: string;
          text: string;
          channelId?: string;
          authorExternalUserId: string;
          expected?: {
            minCreated?: number;
            maxCreated?: number;
            expectActions?: Array<
              "create" | "mark_done" | "mark_cancelled" | "mark_blocked" | "reopen" | "merge_into" | "edit"
            >;
          };
        }>;
      }>(request);
      if (!parsed.ok) {
        return parsed.response;
      }
      const payload = parsed.value;
      if (!payload.workspaceId || !payload.externalWorkspaceId || !payload.organizationId || !payload.cases) {
        return Response.json(
          {
            ok: false,
            error: "workspace_id_external_workspace_id_organization_id_and_cases_required"
          },
          { status: 400 }
        );
      }
      const summary = await runEvalReplay(env, {
        workspaceId: payload.workspaceId,
        externalWorkspaceId: payload.externalWorkspaceId,
        organizationId: payload.organizationId,
        cases: payload.cases
      });
      return Response.json(summary, { status: (summary as { ok?: boolean }).ok ? 200 : 400 });
    }

    if (pathname === "/admin/slack/installs/diagnostics" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      const diagnostics = await getSlackInstallDiagnostics(env);
      return Response.json(diagnostics, { status: 200 });
    }

    if (pathname === "/admin/build-info" && request.method === "GET") {
      const unauthorized = await requireAdmin(request, env);
      if (unauthorized) {
        return unauthorized;
      }
      return Response.json(getBuildInfo(env), { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: BotEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(replayUnprocessedSlackIngestEvents(env, 150));
    ctx.waitUntil(sendReminders(env));
    ctx.waitUntil(runScheduledFollowUpJobs(env));
    ctx.waitUntil(runSlackPollWithMembershipRefresh(env));
    ctx.waitUntil(aggregateDailyUsage(env));
    ctx.waitUntil(syncOpenAiCostReconciliation(env));
  }
};
