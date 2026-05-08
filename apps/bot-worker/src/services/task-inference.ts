import { createLlmClient } from "@ask-thane/ai";
import { D1TaskRepository } from "@ask-thane/data";
import type { MessageEvent } from "@ask-thane/domain";
import { ingestMessageForTasks } from "@ask-thane/workflows";

export interface BotEnv {
  DB: D1Database;
  DEFAULT_LLM_PROVIDER?: "openai" | "anthropic";
  DEFAULT_LLM_MODEL?: string;
}

export async function inferAndPersistTasks(event: MessageEvent, env: BotEnv) {
  const llm = createLlmClient({
    provider: env.DEFAULT_LLM_PROVIDER ?? "openai",
    model: env.DEFAULT_LLM_MODEL ?? "gpt-4.1-mini"
  });

  const repo = new D1TaskRepository(env.DB);
  return ingestMessageForTasks(event, { llm, tasks: repo });
}
