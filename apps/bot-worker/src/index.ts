import { D1TaskRepository } from "@ask-thane/data";
import { healthcheck } from "./routes/health";
import { handleSlackEvents } from "./routes/slack-events";
import { ConversationAccessResolver } from "./services/conversation-access";
import type { BotEnv } from "./services/task-inference";

async function sendReminders(env: BotEnv): Promise<void> {
  const repo = new D1TaskRepository(env.DB);
  await repo.listOpenByAssignee("TODO_WORKSPACE", "TODO_ASSIGNEE");
}

async function reconcileSlackMemberships(env: BotEnv): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) {
    return;
  }

  const resolver = new ConversationAccessResolver(env.DB);
  const workspaces = await resolver.listSlackWorkspaces();

  for (const workspace of workspaces) {
    await resolver.reconcileSlackConversationMemberships({
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      botToken: env.SLACK_BOT_TOKEN
    });
  }
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

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: BotEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendReminders(env));
    ctx.waitUntil(reconcileSlackMemberships(env));
  }
};
