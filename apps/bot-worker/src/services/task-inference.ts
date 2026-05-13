import { createLlmClient } from "@ask-thane/ai";
import { D1TaskRepository } from "@ask-thane/data";
import type { MessageEvent } from "@ask-thane/domain";
import { ingestMessageForTasks } from "@ask-thane/workflows";

export interface BotEnv {
  DB: D1Database;
  DEFAULT_LLM_PROVIDER?: "openai" | "anthropic";
  DEFAULT_LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_OAUTH_STATE_SECRET?: string;
  SLACK_REDIRECT_URI?: string;
  SLACK_BOT_SCOPES?: string;
  DEFAULT_ORGANIZATION_ID?: string;
  THANE_BASE_URL?: string;
}

export async function inferAndPersistTasks(event: MessageEvent, env: BotEnv) {
  const llmOptions: {
    provider: "openai" | "anthropic";
    model: string;
    openAiApiKey?: string;
    anthropicApiKey?: string;
  } = {
    provider: env.DEFAULT_LLM_PROVIDER ?? "openai",
    model: env.DEFAULT_LLM_MODEL ?? "gpt-4.1-mini"
  };
  if (env.OPENAI_API_KEY) {
    llmOptions.openAiApiKey = env.OPENAI_API_KEY;
  }
  if (env.ANTHROPIC_API_KEY) {
    llmOptions.anthropicApiKey = env.ANTHROPIC_API_KEY;
  }

  const llm = createLlmClient(llmOptions);

  const repo = new D1TaskRepository(env.DB);
  return ingestMessageForTasks(event, { llm, tasks: repo });
}
