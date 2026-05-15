import type { BotEnv } from "./task-inference";

export interface OpenAiUsageCost {
  promptCostUsd: number | null;
  completionCostUsd: number | null;
  totalCostUsd: number | null;
  currency: "usd";
  pricingVersion: string;
}

function parseUsdRate(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateOpenAiUsageCost(input: {
  env: BotEnv;
  model: string;
  promptTokens: number;
  completionTokens: number;
}): OpenAiUsageCost {
  const promptPer1kUsd =
    parseUsdRate(input.env.OPENAI_PRICE_PROMPT_PER_1K_USD) ??
    parseUsdRate(input.env.OPENAI_PRICE_INPUT_PER_1K_USD);
  const completionPer1kUsd =
    parseUsdRate(input.env.OPENAI_PRICE_COMPLETION_PER_1K_USD) ??
    parseUsdRate(input.env.OPENAI_PRICE_OUTPUT_PER_1K_USD);

  if (promptPer1kUsd === null || completionPer1kUsd === null) {
    return {
      promptCostUsd: null,
      completionCostUsd: null,
      totalCostUsd: null,
      currency: "usd",
      pricingVersion: input.env.OPENAI_PRICING_VERSION?.trim() || "env_unset_rates",
    };
  }

  const promptCostUsd = roundUsd((input.promptTokens / 1000) * promptPer1kUsd);
  const completionCostUsd = roundUsd((input.completionTokens / 1000) * completionPer1kUsd);

  return {
    promptCostUsd,
    completionCostUsd,
    totalCostUsd: roundUsd(promptCostUsd + completionCostUsd),
    currency: "usd",
    pricingVersion: input.env.OPENAI_PRICING_VERSION?.trim() || `env:${input.model}`
  };
}
