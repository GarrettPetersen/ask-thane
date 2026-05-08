import { normalizeSlackEvent, type SlackEnvelope } from "@ask-thane/integrations";
import { inferAndPersistTasks, type BotEnv } from "../services/task-inference";

export async function handleSlackEvents(request: Request, env: BotEnv): Promise<Response> {
  const payload = (await request.json()) as SlackEnvelope & {
    type?: string;
    challenge?: string;
  };

  if (payload.type === "url_verification" && payload.challenge) {
    return new Response(payload.challenge, { status: 200 });
  }

  const event = normalizeSlackEvent(payload);
  if (!event) {
    return Response.json({ ok: true, ignored: true }, { status: 202 });
  }

  const tasks = await inferAndPersistTasks(event, env);

  return Response.json({ ok: true, taskCount: tasks.length }, { status: 200 });
}
