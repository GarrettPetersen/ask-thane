import { D1TaskRepository, type FollowUpJobRecord } from "@ask-thane/data";
import type { PingLocation, UserRef } from "@ask-thane/domain";
import { runProactiveFollowUpForSlackUser, runProactiveFollowUpForThaneChatUser } from "./agent-runtime";
import { ConversationAccessResolver } from "./conversation-access";
import { fetchSlackUserProfile, openSlackDirectMessage, postSlackMessage } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";
import { postThaneChatWebhookMessage } from "./thane-chat-app-client";

export interface FollowUpRunSummary {
  dueJobs: number;
  sent: number;
  failed: number;
}

interface FollowUpUserRow {
  id: string;
  platform: UserRef["platform"];
  external_user_id: string;
  display_name?: string | null;
  email?: string | null;
}

interface SlackDestination {
  platform: "slack";
  externalUserId: string;
}

interface NativeDestination {
  platform: "thane_cli";
  externalUserId: string;
  email?: string;
  displayName?: string;
}

type FollowUpDestination = SlackDestination | NativeDestination;

function uniqueDestinations(destinations: FollowUpDestination[]): FollowUpDestination[] {
  const seen = new Set<string>();
  const unique: FollowUpDestination[] = [];
  for (const destination of destinations) {
    const key = `${destination.platform}:${destination.externalUserId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(destination);
  }
  return unique;
}

async function nativeAskThaneIntegrationEnabled(env: BotEnv, workspaceId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT enabled FROM thane_cli_ask_thane_integrations WHERE workspace_id = ? LIMIT 1")
    .bind(workspaceId)
    .first<{ enabled?: number | string | null }>();
  return Number(row?.enabled ?? 0) === 1;
}

async function resolveNativeRecipient(env: BotEnv, input: {
  workspaceId: string;
  externalUserId: string;
  email?: string | null;
}): Promise<{ id: string; handle: string; email: string; displayName?: string } | null> {
  const email = input.email?.trim() || input.externalUserId.trim();
  const row = await env.DB
    .prepare(
      `SELECT id, email, display_name, handle
       FROM thane_cli_workspace_members
       WHERE workspace_id = ?
         AND left_at IS NULL
         AND (email = ? OR handle = ?)
       LIMIT 1`
    )
    .bind(input.workspaceId, email, input.externalUserId.trim())
    .first<{ id: string; email: string; display_name?: string | null; handle: string }>();
  if (!row?.id || row.handle === "thane") {
    return null;
  }
  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    ...(row.display_name ? { displayName: row.display_name } : {})
  };
}

async function loadFollowUpUser(env: BotEnv, job: FollowUpJobRecord): Promise<FollowUpUserRow> {
  const user = await env.DB
    .prepare(
      `SELECT id, platform, external_user_id, display_name, email
       FROM users
       WHERE organization_id = ? AND workspace_id = ? AND id = ?
       LIMIT 1`
    )
    .bind(job.organizationId, job.workspaceId, job.userId)
    .first<FollowUpUserRow>();
  if (!user?.id) {
    throw new Error("follow_up_user_not_found");
  }
  return user;
}

async function resolveFollowUpDestinations(input: {
  env: BotEnv;
  repo: D1TaskRepository;
  job: FollowUpJobRecord;
  user: FollowUpUserRow;
  tokenByWorkspace: Map<string, string>;
}): Promise<FollowUpDestination[]> {
  const originPlatform = input.user.platform === "thane_cli" ? "thane_cli" : "slack";
  const origin: FollowUpDestination =
    originPlatform === "thane_cli"
      ? {
          platform: "thane_cli",
          externalUserId: input.user.external_user_id,
          ...(input.user.email ? { email: input.user.email } : {}),
          ...(input.user.display_name ? { displayName: input.user.display_name } : {})
        }
      : { platform: "slack", externalUserId: input.user.external_user_id };

  const person = await input.repo.getPersonByUserId(input.job.organizationId, input.job.userId).catch(() => null);
  const preference = person
    ? await input.repo.getPersonNotificationPreference({
        organizationId: input.job.organizationId,
        personId: person.id
      })
    : null;
  const requestedLocation: PingLocation = preference?.preferredPingLocation ?? "origin";

  const available: FollowUpDestination[] = [origin];
  if (person) {
    const identities = await input.repo.listIdentityAccountsForPerson(input.job.organizationId, person.id).catch(() => []);
    for (const identity of identities) {
      if (identity.provider === "slack" && input.tokenByWorkspace.has(input.job.workspaceId)) {
        available.push({ platform: "slack", externalUserId: identity.externalUserId });
      }
      if (identity.provider === "thane_cli" && (await nativeAskThaneIntegrationEnabled(input.env, input.job.workspaceId))) {
        available.push({
          platform: "thane_cli",
          externalUserId: identity.externalUserId,
          ...(identity.email ? { email: identity.email } : {}),
          ...(identity.displayName ? { displayName: identity.displayName } : {})
        });
      }
    }
  }

  const unique = uniqueDestinations(available);
  if (requestedLocation === "both") {
    return unique;
  }
  if (requestedLocation === "origin") {
    return [origin];
  }
  const requested = unique.find((destination) => destination.platform === requestedLocation);
  return requested ? [requested] : [origin];
}

async function dispatchSlackFollowUp(input: {
  env: BotEnv;
  resolver: ConversationAccessResolver;
  job: FollowUpJobRecord;
  destination: SlackDestination;
  botToken: string;
  externalWorkspaceId: string;
  nowIso: string;
}): Promise<{ text: string; channelId: string; messageTs: string }> {
  const profile = await fetchSlackUserProfile({
    botToken: input.botToken,
    userId: input.destination.externalUserId
  });
  const isUnremindable =
    !profile ||
    profile.isStranger === true ||
    (profile.teamId && profile.teamId !== input.externalWorkspaceId);
  if (isUnremindable) {
    const reason = !profile
      ? "non_remindable_missing_profile"
      : profile.isStranger
        ? "non_remindable_is_stranger"
        : "non_remindable_foreign_team";
    throw new Error(reason);
  }

  const dm = await openSlackDirectMessage({
    botToken: input.botToken,
    userId: input.destination.externalUserId
  });

  const conversationSource = await input.resolver.upsertSlackConversationSource({
    organizationId: input.job.organizationId,
    workspaceId: input.job.workspaceId,
    channelId: dm.channelId,
    conversationKind: "dm",
    isPublic: false,
    nowIso: input.nowIso
  });
  await input.resolver.ensureSlackConversationMembership({
    organizationId: input.job.organizationId,
    workspaceId: input.job.workspaceId,
    conversationSourceId: conversationSource.id,
    platformUserId: input.destination.externalUserId,
    nowIso: input.nowIso
  });

  const agent = await runProactiveFollowUpForSlackUser({
    env: input.env,
    organizationId: input.job.organizationId,
    workspaceId: input.job.workspaceId,
    externalWorkspaceId: input.externalWorkspaceId,
    conversationSourceId: conversationSource.id,
    channelId: dm.channelId,
    externalUserId: input.destination.externalUserId,
    prompt: input.job.prompt,
    ...(input.job.context ? { context: input.job.context } : {})
  });

  const text =
    agent.replyText?.trim() ||
    "Quick proactive check-in from Thane: tell me if any of your priorities changed, and I can adjust your task list.";

  const posted = await postSlackMessage({
    botToken: input.botToken,
    channelId: dm.channelId,
    text
  });

  return { text, channelId: posted.channelId, messageTs: posted.ts };
}

async function resolveNativeFollowUpContext(env: BotEnv, job: FollowUpJobRecord): Promise<{ conversationSourceId: string; channelId: string }> {
  if (job.sourceConversationSourceId) {
    const source = await env.DB
      .prepare(
        `SELECT id, provider_conversation_id
         FROM conversation_sources
         WHERE organization_id = ?
           AND workspace_id = ?
           AND provider = 'thane_cli'
           AND id = ?
         LIMIT 1`
      )
      .bind(job.organizationId, job.workspaceId, job.sourceConversationSourceId)
      .first<{ id?: string; provider_conversation_id?: string }>();
    if (source?.id && source.provider_conversation_id) {
      return { conversationSourceId: source.id, channelId: source.provider_conversation_id };
    }
  }

  const fallback = await env.DB
    .prepare(
      `SELECT id, provider_conversation_id
       FROM conversation_sources
       WHERE organization_id = ?
         AND workspace_id = ?
         AND provider = 'thane_cli'
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .bind(job.organizationId, job.workspaceId)
    .first<{ id?: string; provider_conversation_id?: string }>();
  if (!fallback?.id || !fallback.provider_conversation_id) {
    throw new Error("native_follow_up_context_missing");
  }
  return { conversationSourceId: fallback.id, channelId: fallback.provider_conversation_id };
}

async function dispatchNativeFollowUp(input: {
  env: BotEnv;
  job: FollowUpJobRecord;
  destination: NativeDestination;
  nowIso: string;
}): Promise<{ text: string; channelId: string; messageTs: string }> {
  if (!(await nativeAskThaneIntegrationEnabled(input.env, input.job.workspaceId))) {
    throw new Error("ask_thane_not_enabled");
  }
  const recipient = await resolveNativeRecipient(input.env, {
    workspaceId: input.job.workspaceId,
    externalUserId: input.destination.externalUserId,
    ...(input.destination.email ? { email: input.destination.email } : {})
  });
  if (!recipient) {
    throw new Error("native_recipient_not_found");
  }
  const context = await resolveNativeFollowUpContext(input.env, input.job);
  const authorDisplayName = input.destination.displayName ?? recipient.displayName;
  const agent = await runProactiveFollowUpForThaneChatUser({
    env: input.env,
    organizationId: input.job.organizationId,
    workspaceId: input.job.workspaceId,
    conversationSourceId: context.conversationSourceId,
    channelId: context.channelId,
    externalUserId: recipient.email,
    authorEmail: recipient.email,
    ...(authorDisplayName ? { authorDisplayName } : {}),
    prompt: input.job.prompt,
    ...(input.job.context ? { context: input.job.context } : {})
  });

  const text =
    agent.replyText?.trim() ||
    "Quick proactive check-in from Thane: tell me if any of your priorities changed, and I can adjust your task list.";
  const posted = await postThaneChatWebhookMessage({
    env: input.env,
    workspaceId: input.job.workspaceId,
    dmTarget: recipient.email,
    text
  });
  if (!posted.messageId || !posted.channelId) {
    throw new Error("native_follow_up_webhook_message_missing");
  }
  return { text, channelId: posted.channelId, messageTs: posted.messageId };
}

export async function runScheduledFollowUpJobs(env: BotEnv): Promise<FollowUpRunSummary> {
  const repo = new D1TaskRepository(env.DB);
  const resolver = new ConversationAccessResolver(env.DB);
  const installStore = new SlackInstallStore(env.DB);
  const nowIso = new Date().toISOString();

  const dueJobs = await repo.listDueFollowUpJobs(nowIso, 100);
  const installs = await installStore.listWorkspaceInstalls();
  const tokenByWorkspace = new Map(installs.map((row) => [row.workspaceId, row.botToken]));
  const externalWorkspaceByWorkspace = new Map(installs.map((row) => [row.workspaceId, row.externalWorkspaceId]));

  const summary: FollowUpRunSummary = {
    dueJobs: dueJobs.length,
    sent: 0,
    failed: 0
  };

  for (const job of dueJobs) {
    try {
      const user = await loadFollowUpUser(env, job);
      const destinations = await resolveFollowUpDestinations({
        env,
        repo,
        job,
        user,
        tokenByWorkspace
      });
      let sent: { text: string; channelId: string; messageTs: string } | null = null;
      const failures: string[] = [];

      for (const destination of destinations) {
        try {
          if (destination.platform === "slack") {
            const botToken = tokenByWorkspace.get(job.workspaceId) ?? env.SLACK_BOT_TOKEN;
            if (!botToken) {
              throw new Error("missing_slack_bot_token");
            }
            const externalWorkspaceId = externalWorkspaceByWorkspace.get(job.workspaceId);
            if (!externalWorkspaceId) {
              throw new Error("missing_external_workspace_id_for_job_workspace");
            }
            sent = await dispatchSlackFollowUp({
              env,
              resolver,
              job,
              destination,
              botToken,
              externalWorkspaceId,
              nowIso
            });
          } else {
            sent = await dispatchNativeFollowUp({
              env,
              job,
              destination,
              nowIso
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push(`${destination.platform}:${reason}`);
          console.error("follow_up_destination_failed", {
            jobId: job.id,
            workspaceId: job.workspaceId,
            platform: destination.platform,
            reason
          });
        }
      }

      if (!sent) {
        throw new Error(failures.join(";") || "no_follow_up_destination_sent");
      }

      await repo.markFollowUpJobSent({
        id: job.id,
        responseText: sent.text,
        messageChannelId: sent.channelId,
        messageTs: sent.messageTs,
        sentAt: nowIso
      });
      summary.sent += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await repo.markFollowUpJobFailed({
        id: job.id,
        errorText: reason,
        attemptedAt: nowIso
      });
      summary.failed += 1;
      console.error("follow_up_job_failed", {
        jobId: job.id,
        workspaceId: job.workspaceId,
        reason
      });
    }
  }

  return summary;
}

export const __testables = {
  dispatchNativeFollowUp,
  resolveFollowUpDestinations
};
