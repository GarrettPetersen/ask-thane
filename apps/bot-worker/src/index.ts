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
import { getSlackInstallDiagnostics } from "./services/onboarding-diagnostics";
import { getOpsSummary, getWorkspaceOpsSummary } from "./services/ops-dashboard";
import { runScheduledReminderDigests, runWorkspaceReminderDigestsNow } from "./services/reminder-digests";
import { pollSlackWorkspacesForTasks } from "./services/slack-poller";
import { SlackInstallStore } from "./services/slack-install-store";
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

async function parseJsonBody<T>(request: Request): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    const payload = (await request.json()) as T;
    return { ok: true, value: payload };
  } catch {
    return { ok: false, response: Response.json({ ok: false, error: "invalid_json_body" }, { status: 400 }) };
  }
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

    if (pathname === "/slack/install" && request.method === "GET") {
      return handleSlackInstallStart(request, env);
    }

    if (pathname === "/slack/oauth/callback" && request.method === "GET") {
      return handleSlackOAuthCallback(request, env);
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
