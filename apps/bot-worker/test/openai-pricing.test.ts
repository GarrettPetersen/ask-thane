import { describe, expect, it } from "vitest";
import { estimateOpenAiUsageCost } from "../src/services/openai-pricing";

describe("openai pricing estimator", () => {
  it("returns null costs when rates are not configured", () => {
    const result = estimateOpenAiUsageCost({
      env: { DB: {} as D1Database },
      model: "gpt-4.1-mini",
      promptTokens: 1000,
      completionTokens: 500
    });
    expect(result.totalCostUsd).toBeNull();
    expect(result.pricingVersion).toBe("env_unset_rates");
  });

  it("computes per-call cost from configured prompt/completion rates", () => {
    const result = estimateOpenAiUsageCost({
      env: {
        DB: {} as D1Database,
        OPENAI_PRICE_PROMPT_PER_1K_USD: "0.01",
        OPENAI_PRICE_COMPLETION_PER_1K_USD: "0.02",
        OPENAI_PRICING_VERSION: "test-v1"
      },
      model: "gpt-4.1-mini",
      promptTokens: 1500,
      completionTokens: 2000
    });
    expect(result.promptCostUsd).toBe(0.015);
    expect(result.completionCostUsd).toBe(0.04);
    expect(result.totalCostUsd).toBe(0.055);
    expect(result.pricingVersion).toBe("test-v1");
  });

  it("supports input/output rate aliases", () => {
    const result = estimateOpenAiUsageCost({
      env: {
        DB: {} as D1Database,
        OPENAI_PRICE_INPUT_PER_1K_USD: "0.003",
        OPENAI_PRICE_OUTPUT_PER_1K_USD: "0.006"
      },
      model: "gpt-5.4-mini",
      promptTokens: 1000,
      completionTokens: 1000
    });

    expect(result.promptCostUsd).toBe(0.003);
    expect(result.completionCostUsd).toBe(0.006);
    expect(result.totalCostUsd).toBe(0.009);
    expect(result.pricingVersion).toBe("env:gpt-5.4-mini");
  });

  it("rejects invalid rates", () => {
    const result = estimateOpenAiUsageCost({
      env: {
        DB: {} as D1Database,
        OPENAI_PRICE_PROMPT_PER_1K_USD: "-1",
        OPENAI_PRICE_COMPLETION_PER_1K_USD: "abc"
      },
      model: "gpt-5.4-mini",
      promptTokens: 1000,
      completionTokens: 1000
    });

    expect(result.totalCostUsd).toBeNull();
    expect(result.pricingVersion).toBe("env_unset_rates");
  });
});
