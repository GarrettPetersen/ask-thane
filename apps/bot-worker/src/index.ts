import { D1TaskRepository } from "@ask-thane/data";
import { healthcheck } from "./routes/health";
import { handleSlackEvents } from "./routes/slack-events";
import { handleSlackInstallStart, handleSlackOAuthCallback } from "./routes/slack-oauth";
import { ConversationAccessResolver } from "./services/conversation-access";
import { runScheduledFollowUpJobs } from "./services/follow-up-jobs";
import { runScheduledReminderDigests } from "./services/reminder-digests";
import { pollSlackWorkspacesForTasks } from "./services/slack-poller";
import { SlackInstallStore } from "./services/slack-install-store";
import type { BotEnv } from "./services/task-inference";

async function sendReminders(env: BotEnv): Promise<void> {
  await runScheduledReminderDigests(env);
}

async function reconcileSlackMemberships(env: BotEnv): Promise<void> {
  const resolver = new ConversationAccessResolver(env.DB);
  const installs = new SlackInstallStore(env.DB);
  const workspaceInstalls = await installs.listWorkspaceInstalls();

  for (const workspace of workspaceInstalls) {
    await resolver.reconcileSlackConversationMemberships({
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      botToken: workspace.botToken
    });
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

    await resolver.reconcileSlackConversationMemberships({
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      botToken: env.SLACK_BOT_TOKEN
    });
  }
}

function isAdminAuthorized(request: Request, env: BotEnv): boolean {
  const requiredToken = env.ADMIN_TRIGGER_TOKEN?.trim();
  if (!requiredToken) {
    return false;
  }

  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice("Bearer ".length).trim();
    if (bearer && bearer === requiredToken) {
      return true;
    }
  }

  const headerToken = request.headers.get("x-admin-token")?.trim();
  return Boolean(headerToken && headerToken === requiredToken);
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
  async fetch(request: Request, env: BotEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return healthcheck();
    }

    if (pathname === "/webhooks/slack/events" && request.method === "POST") {
      return handleSlackEvents(request, env);
    }

    if (pathname === "/slack/install" && request.method === "GET") {
      return handleSlackInstallStart(request, env);
    }

    if (pathname === "/slack/oauth/callback" && request.method === "GET") {
      return handleSlackOAuthCallback(request, env);
    }

    if (pathname === "/admin/poll/run" && request.method === "POST") {
      if (!isAdminAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const summary = await pollSlackWorkspacesForTasks(env);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/poll/status" && request.method === "GET") {
      if (!isAdminAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const status = await getPollStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/reminders/run" && request.method === "POST") {
      if (!isAdminAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const summary = await runScheduledReminderDigests(env);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/reminders/status" && request.method === "GET") {
      if (!isAdminAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const status = await getDigestStatus(env);
      return Response.json(status, { status: 200 });
    }

    if (pathname === "/admin/followups/run" && request.method === "POST") {
      if (!isAdminAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const summary = await runScheduledFollowUpJobs(env);
      return Response.json({ ok: true, summary }, { status: 200 });
    }

    if (pathname === "/admin/followups/status" && request.method === "GET") {
      if (!isAdminAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const status = await getFollowUpStatus(env);
      return Response.json(status, { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: BotEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendReminders(env));
    ctx.waitUntil(runScheduledFollowUpJobs(env));
    ctx.waitUntil(reconcileSlackMemberships(env));
    ctx.waitUntil(pollSlackWorkspacesForTasks(env));
  }
};
