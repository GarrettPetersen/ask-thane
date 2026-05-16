import { createLlmClient } from "@ask-thane/ai";
import { D1TaskRepository } from "@ask-thane/data";
import type { MessageEvent } from "@ask-thane/domain";
import { ingestMessageForTasks } from "@ask-thane/workflows";

export interface BotEnv {
  DB: D1Database;
  TASKS_API_BASE_URL?: string;
  INTERNAL_API_BEARER_TOKEN?: string;
  BILLING_LINK_SIGNING_SECRET?: string;
  BUILD_ENV?: string;
  BUILD_GIT_SHA?: string;
  BUILD_DEPLOYED_AT?: string;
  DEFAULT_LLM_PROVIDER?: "openai" | "anthropic";
  DEFAULT_LLM_MODEL?: string;
  FREE_TIER_LLM_MODEL?: string;
  PAID_TIER_LLM_MODEL?: string;
  TEAM_TIER_LLM_MODEL?: string;
  GROWTH_TIER_LLM_MODEL?: string;
  SCALE_TIER_LLM_MODEL?: string;
  SCALE_PLUS_TIER_LLM_MODEL?: string;
  PAID_TIER_DIGEST_LLM_MODEL?: string;
  FREE_TIER_MONTHLY_AI_CAP_USD?: string;
  SUBSCRIPTION_PAGE_URL?: string;
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
  ADMIN_TRIGGER_TOKEN?: string;
  ADMIN_HMAC_KEYS?: string;
  ADMIN_HMAC_MAX_SKEW_SECONDS?: string;
  AGENT_MAX_TOOL_TURNS?: string;
  AGENT_COMPLETION_RETRIES?: string;
  AGENT_TOOL_READ_LIMIT?: string;
  AGENT_COMPLETION_TIMEOUT_MS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_METER_NAME_ACTIVE_USERS?: string;
  STRIPE_METER_NAME_ACTIVE_CHANNELS?: string;
  STRIPE_METER_NAME_TASK_EVENTS?: string;
  STRIPE_METER_NAME_LLM_COST_USD?: string;
  STRIPE_METER_NAME_AI_OVERAGE_USD?: string;
  OPENAI_ADMIN_API_KEY?: string;
  OPENAI_ORGANIZATION_ID?: string;
  OPENAI_COST_RECONCILIATION_ENABLED?: string;
  OPENAI_RECON_ALERT_THRESHOLD_PCT?: string;
  OPENAI_PRICE_PROMPT_PER_1K_USD?: string;
  OPENAI_PRICE_COMPLETION_PER_1K_USD?: string;
  OPENAI_PRICE_INPUT_PER_1K_USD?: string;
  OPENAI_PRICE_OUTPUT_PER_1K_USD?: string;
  OPENAI_PRICING_VERSION?: string;
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
