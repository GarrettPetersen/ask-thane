import { D1TaskRepository } from "@ask-thane/data";
import { runProactiveFollowUpForSlackUser } from "./agent-runtime";
import { ConversationAccessResolver } from "./conversation-access";
import { openSlackDirectMessage, postSlackMessage } from "./slack-api";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

export interface FollowUpRunSummary {
  dueJobs: number;
  sent: number;
  failed: number;
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
      const botToken = tokenByWorkspace.get(job.workspaceId) ?? env.SLACK_BOT_TOKEN;
      if (!botToken) {
        throw new Error("missing_slack_bot_token");
      }

      const externalWorkspaceId = externalWorkspaceByWorkspace.get(job.workspaceId);
      if (!externalWorkspaceId) {
        throw new Error("missing_external_workspace_id_for_job_workspace");
      }

      const dm = await openSlackDirectMessage({
        botToken,
        userId: job.externalUserId
      });

      const conversationSource = await resolver.upsertSlackConversationSource({
        organizationId: job.organizationId,
        workspaceId: job.workspaceId,
        channelId: dm.channelId,
        conversationKind: "dm",
        isPublic: false,
        nowIso
      });
      await resolver.ensureSlackConversationMembership({
        organizationId: job.organizationId,
        workspaceId: job.workspaceId,
        conversationSourceId: conversationSource.id,
        platformUserId: job.externalUserId,
        nowIso
      });

      const agent = await runProactiveFollowUpForSlackUser({
        env,
        organizationId: job.organizationId,
        workspaceId: job.workspaceId,
        externalWorkspaceId,
        conversationSourceId: conversationSource.id,
        channelId: dm.channelId,
        externalUserId: job.externalUserId,
        prompt: job.prompt,
        ...(job.context ? { context: job.context } : {})
      });

      const text =
        agent.replyText?.trim() ||
        "Quick proactive check-in from Thane: tell me if any of your priorities changed, and I can adjust your task list.";

      const posted = await postSlackMessage({
        botToken,
        channelId: dm.channelId,
        text
      });

      await repo.markFollowUpJobSent({
        id: job.id,
        responseText: text,
        messageChannelId: posted.channelId,
        messageTs: posted.ts,
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
