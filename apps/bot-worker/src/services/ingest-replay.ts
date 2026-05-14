import { D1TaskRepository } from "@ask-thane/data";
import { runConversationalAgentForSlackMessage } from "./agent-runtime";
import { ConversationAccessResolver } from "./conversation-access";
import { fetchSlackMessageByTs } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface ReplayableSlackIngestRow {
  organizationId: string;
  providerEventId: string;
  providerMessageId?: string;
  conversationSourceId?: string;
  workspaceId?: string;
  channelId?: string;
  externalWorkspaceId?: string;
  receivedAt: string;
}

export interface ReplaySlackIngestSummary {
  startedAt: string;
  finishedAt: string;
  requestedLimit: number;
  rowsSelected: number;
  replayed: number;
  replayedTaskCreates: number;
  skippedAlreadyProcessed: number;
  skippedUnrecoverable: number;
  skippedMessageMissing: number;
  skippedNonUserMessage: number;
  failed: number;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

function isSlackAuthError(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes("invalid_auth") || reason.includes("not_authed");
}

function uniqueTokens(primary: string | null, fallback: string | undefined): string[] {
  const tokens: string[] = [];
  if (primary) {
    tokens.push(primary);
  }
  if (fallback && fallback !== primary) {
    tokens.push(fallback);
  }
  return tokens;
}

function isoFromSlackTs(ts: string): string {
  const seconds = Number(ts.split(".")[0] ?? "");
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

async function listReplayableRows(env: BotEnv, limit: number): Promise<ReplayableSlackIngestRow[]> {
  const rows = await env.DB
    .prepare(
      `SELECT
         ie.organization_id,
         ie.provider_event_id,
         ie.provider_message_id,
         ie.conversation_source_id,
         ie.received_at,
         cs.workspace_id,
         cs.provider_conversation_id,
         w.external_workspace_id
       FROM ingest_events ie
       LEFT JOIN conversation_sources cs
         ON cs.id = ie.conversation_source_id
       LEFT JOIN workspaces w
         ON w.id = cs.workspace_id
       WHERE ie.provider = 'slack'
         AND ie.processed_at IS NULL
       ORDER BY ie.received_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map((row) => ({
    organizationId: String(row.organization_id),
    providerEventId: String(row.provider_event_id),
    ...(row.provider_message_id ? { providerMessageId: String(row.provider_message_id) } : {}),
    ...(row.conversation_source_id ? { conversationSourceId: String(row.conversation_source_id) } : {}),
    ...(row.workspace_id ? { workspaceId: String(row.workspace_id) } : {}),
    ...(row.provider_conversation_id ? { channelId: String(row.provider_conversation_id) } : {}),
    ...(row.external_workspace_id ? { externalWorkspaceId: String(row.external_workspace_id) } : {}),
    receivedAt: String(row.received_at)
  }));
}

async function isAlreadyProcessed(input: {
  env: BotEnv;
  organizationId: string;
  providerEventId: string;
}): Promise<boolean> {
  const row = await input.env.DB
    .prepare(
      `SELECT processed_at
       FROM ingest_events
       WHERE organization_id = ?
         AND provider = 'slack'
         AND provider_event_id = ?
       LIMIT 1`
    )
    .bind(input.organizationId, input.providerEventId)
    .first<Record<string, unknown>>();
  return Boolean(row?.processed_at);
}

export async function replayUnprocessedSlackIngestEvents(
  env: BotEnv,
  limit?: number
): Promise<ReplaySlackIngestSummary> {
  const startedAt = new Date().toISOString();
  const requestedLimit = clampLimit(limit, 100, 500);

  const repo = new D1TaskRepository(env.DB);
  const resolver = new ConversationAccessResolver(env.DB);
  const installs = new SlackInstallStore(env.DB);

  const rows = await listReplayableRows(env, requestedLimit);
  const installList = await installs.listWorkspaceInstalls();
  const installTokenByExternalWorkspace = new Map(
    installList.map((row) => [row.externalWorkspaceId, row.botToken] as const)
  );

  const summary: ReplaySlackIngestSummary = {
    startedAt,
    finishedAt: startedAt,
    requestedLimit,
    rowsSelected: rows.length,
    replayed: 0,
    replayedTaskCreates: 0,
    skippedAlreadyProcessed: 0,
    skippedUnrecoverable: 0,
    skippedMessageMissing: 0,
    skippedNonUserMessage: 0,
    failed: 0
  };

  for (const row of rows) {
    if (
      !row.providerMessageId ||
      !row.conversationSourceId ||
      !row.workspaceId ||
      !row.channelId ||
      !row.externalWorkspaceId
    ) {
      await repo.markIngestEventProcessed(row.organizationId, "slack", row.providerEventId, new Date().toISOString());
      summary.skippedUnrecoverable += 1;
      continue;
    }

    if (
      await isAlreadyProcessed({
        env,
        organizationId: row.organizationId,
        providerEventId: row.providerEventId
      })
    ) {
      summary.skippedAlreadyProcessed += 1;
      continue;
    }

    try {
      const installToken = installTokenByExternalWorkspace.get(row.externalWorkspaceId) ?? null;
      const tokens = uniqueTokens(installToken, env.SLACK_BOT_TOKEN);
      let message: Awaited<ReturnType<typeof fetchSlackMessageByTs>>["message"] = null;

      for (const token of tokens) {
        try {
          const fetched = await fetchSlackMessageByTs({
            botToken: token,
            channelId: row.channelId,
            messageTs: row.providerMessageId
          });
          message = fetched.message;
          break;
        } catch (error) {
          if (isSlackAuthError(error)) {
            continue;
          }
          throw error;
        }
      }

      if (!message) {
        await repo.markIngestEventProcessed(row.organizationId, "slack", row.providerEventId, new Date().toISOString());
        summary.skippedMessageMissing += 1;
        continue;
      }

      const authorId = message.user?.trim() ?? "";
      const text = message.text?.trim() ?? "";
      if (!authorId || !text || message.subtype === "bot_message") {
        await repo.markIngestEventProcessed(row.organizationId, "slack", row.providerEventId, new Date().toISOString());
        summary.skippedNonUserMessage += 1;
        continue;
      }

      const nowIso = isoFromSlackTs(row.providerMessageId);
      await resolver.ensureSlackConversationMembership({
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        conversationSourceId: row.conversationSourceId,
        platformUserId: authorId,
        nowIso
      });

      const agent = await runConversationalAgentForSlackMessage({
        env,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        externalWorkspaceId: row.externalWorkspaceId,
        conversationSourceId: row.conversationSourceId,
        interactionMode: "passive_ingest",
        event: {
          workspaceId: row.workspaceId,
          channelId: row.channelId,
          messageId: row.providerMessageId,
          text,
          occurredAt: nowIso,
          author: {
            platform: "slack",
            platformUserId: authorId
          }
        }
      });

      await repo.markIngestEventProcessed(row.organizationId, "slack", row.providerEventId, new Date().toISOString());
      summary.replayed += 1;
      summary.replayedTaskCreates += agent.createdTaskIds.length;
    } catch (error) {
      summary.failed += 1;
      console.error("slack_ingest_replay_failed", {
        organizationId: row.organizationId,
        providerEventId: row.providerEventId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
