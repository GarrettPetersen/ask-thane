import { describe, expect, it, vi } from "vitest";
import {
  countBillableActiveUsersForWorkspace,
  estimateWorkspaceMonthlyBill,
  evaluateActiveUserGateForTaskWrite,
  evaluateFreeTierAiSpendGateForTaskWrite,
  markWorkspaceUsersDeactivated,
  recordWorkspaceUserActivity,
  resolveModelForWorkspaceTier,
  resolveWorkspaceBillingPolicy
} from "../src/services/billing-policy";

function makeDbStub(handler: (sql: string, args: unknown[]) => unknown) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: vi.fn(async () => handler(sql, args)),
      run,
      all: vi.fn(async () => ({ results: [] }))
    })
  }));
  return { prepare, run };
}

describe("billing policy tiers", () => {
  it("maps legacy plan tiers to new catalog defaults", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "starter",
          included_active_users: null,
          hard_cap_active_users: null,
          active_user_window_days: 30,
          overage_enabled: 1,
          is_enabled: 1,
          metadata_json: null
        };
      }
      return null;
    });

    const policy = await resolveWorkspaceBillingPolicy({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1"
    });

    expect(policy.planTier).toBe("team");
    expect(policy.monthlyBasePriceUsd).toBe(99);
    expect(policy.includedAiCostUsd).toBe(20);
  });

  it("applies metadata overrides for pricing fields", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "team",
          included_active_users: null,
          hard_cap_active_users: null,
          active_user_window_days: 30,
          overage_enabled: 1,
          is_enabled: 1,
          metadata_json: JSON.stringify({
            monthly_base_price_usd: 111,
            per_user_overage_usd: 4,
            included_ai_cost_usd: 33,
            ai_overage_multiplier: 1.4
          })
        };
      }
      return null;
    });

    const policy = await resolveWorkspaceBillingPolicy({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1"
    });

    expect(policy.monthlyBasePriceUsd).toBe(111);
    expect(policy.perUserOverageUsd).toBe(4);
    expect(policy.includedAiCostUsd).toBe(33);
    expect(policy.aiOverageMultiplier).toBe(1.4);
  });

  it("computes monthly estimate from participant and AI overages", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "growth",
          included_active_users: null,
          hard_cap_active_users: null,
          active_user_window_days: 30,
          overage_enabled: 1,
          is_enabled: 1,
          metadata_json: null
        };
      }
      if (sql.includes("COUNT(*) AS active_users")) {
        return { active_users: 130 };
      }
      if (sql.includes("SUM(total_cost_usd) AS ai_cost_usd") || sql.includes("SUM(total_cost_usd), 0) AS ai_cost_usd")) {
        return { ai_cost_usd: 200 };
      }
      return null;
    });

    const estimate = await estimateWorkspaceMonthlyBill({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1",
      monthStartIso: "2026-05-01T00:00:00.000Z",
      monthEndIso: "2026-05-31T23:59:59.999Z"
    });

    expect(estimate.participantOverageUsers).toBe(30);
    expect(estimate.participantOverageUsd).toBe(60);
    expect(estimate.aiOverageUsd).toBeCloseTo((200 - 120) * 1.3, 6);
    expect(estimate.estimatedMonthlyTotalUsd).toBeCloseTo(299 + 60 + (200 - 120) * 1.3, 6);
  });

  it("counts billable active users with custom active window", async () => {
    const db = makeDbStub((sql, args) => {
      if (sql.includes("COUNT(*) AS active_users")) {
        expect(args[2]).toBe("2026-05-12T00:00:00.000Z");
        expect(args[3]).toBe("2026-05-14T00:00:00.000Z");
        return { active_users: 7 };
      }
      return null;
    });

    const count = await countBillableActiveUsersForWorkspace({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1",
      asOfIso: "2026-05-14T00:00:00.000Z",
      activeWindowDays: 2
    });

    expect(count).toBe(7);
  });

  it("blocks new over-cap users on free tier", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "free",
          included_active_users: 10,
          hard_cap_active_users: 10,
          active_user_window_days: 30,
          overage_enabled: 0,
          is_enabled: 1,
          metadata_json: null
        };
      }
      if (sql.includes("FROM workspace_user_activity") && sql.includes("external_user_id = ?")) {
        return null;
      }
      if (sql.includes("COUNT(*) AS active_users")) {
        return { active_users: 10 };
      }
      return null;
    });

    const result = await evaluateActiveUserGateForTaskWrite({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1",
      externalUserId: "U_NEW",
      nowIso: "2026-05-14T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "free_tier_active_user_limit_reached",
      activeUsersCount: 10,
      countedUserIsAlreadyActive: false
    });
  });

  it("allows already-active users at cap", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "free",
          included_active_users: 10,
          hard_cap_active_users: 10,
          active_user_window_days: 30,
          overage_enabled: 0,
          is_enabled: 1,
          metadata_json: null
        };
      }
      if (sql.includes("FROM workspace_user_activity") && sql.includes("external_user_id = ?")) {
        return { id: "activity_1" };
      }
      if (sql.includes("COUNT(*) AS active_users")) {
        return { active_users: 10 };
      }
      return null;
    });

    const result = await evaluateActiveUserGateForTaskWrite({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1",
      externalUserId: "U_EXISTING",
      nowIso: "2026-05-14T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      allowed: true,
      activeUsersCount: 10,
      countedUserIsAlreadyActive: true
    });
  });

  it("records workspace user activity", async () => {
    const db = makeDbStub(() => null);

    await recordWorkspaceUserActivity({
      env: { DB: db as unknown as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1",
      userId: "user_1",
      externalUserId: "U123",
      eventType: "task_created",
      activityAt: "2026-05-14T20:00:00.000Z",
      sourceConversationSourceId: "conv_1",
      sourceMessageId: "1710000000.000001",
      metadata: { mode: "dm_reply" }
    });

    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it("marks workspace users deactivated with and without active id list", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ run }))
    }));
    const db = { prepare } as unknown as D1Database;

    await markWorkspaceUsersDeactivated({
      db,
      organizationId: "org_0",
      workspaceId: "ws_1",
      activeExternalUserIds: [],
      nowIso: "2026-05-14T20:00:00.000Z"
    });

    await markWorkspaceUsersDeactivated({
      db,
      organizationId: "org_0",
      workspaceId: "ws_1",
      activeExternalUserIds: ["U1", "U2"],
      nowIso: "2026-05-14T20:00:00.000Z"
    });

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("selects free-tier vs paid-tier models", () => {
    const env = {
      DB: {} as D1Database,
      DEFAULT_LLM_MODEL: "gpt-5.4-mini",
      FREE_TIER_LLM_MODEL: "gpt-4.1-mini",
      PAID_TIER_LLM_MODEL: "gpt-5.4-mini",
      TEAM_TIER_LLM_MODEL: "gpt-5.4"
    };

    expect(resolveModelForWorkspaceTier({ env, planTier: "free", usage: "agent" })).toBe("gpt-4.1-mini");
    expect(resolveModelForWorkspaceTier({ env, planTier: "team", usage: "agent" })).toBe("gpt-5.4");
    expect(resolveModelForWorkspaceTier({ env, planTier: "growth", usage: "agent" })).toBe("gpt-5.4-mini");
  });

  it("allows paid digest model override", () => {
    const env = {
      DB: {} as D1Database,
      DEFAULT_LLM_MODEL: "gpt-5.4-mini",
      PAID_TIER_LLM_MODEL: "gpt-5.4-mini",
      PAID_TIER_DIGEST_LLM_MODEL: "gpt-5.5"
    };

    expect(resolveModelForWorkspaceTier({ env, planTier: "team", usage: "digest" })).toBe("gpt-5.5");
  });

  it("blocks free tier task writes after monthly AI spend cap", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "free",
          included_active_users: 10,
          hard_cap_active_users: 10,
          active_user_window_days: 30,
          overage_enabled: 0,
          is_enabled: 1,
          metadata_json: null
        };
      }
      if (sql.includes("month_cost_usd")) {
        return { month_cost_usd: 11.2 };
      }
      return null;
    });

    const gate = await evaluateFreeTierAiSpendGateForTaskWrite({
      env: { DB: db as unknown as D1Database, FREE_TIER_MONTHLY_AI_CAP_USD: "10" },
      organizationId: "org_0",
      workspaceId: "ws_1",
      nowIso: "2026-05-14T20:00:00.000Z"
    });

    expect(gate).toMatchObject({
      allowed: false,
      reason: "free_tier_ai_spend_limit_reached",
      monthlyCapUsd: 10
    });
    expect(gate.monthlySpendUsd).toBeCloseTo(11.2, 6);
    expect(gate.resetsAtIso).toBe("2026-06-01T00:00:00.000Z");
  });

  it("does not apply monthly AI cap to paid tiers", async () => {
    const db = makeDbStub((sql) => {
      if (sql.includes("effective_plan_tier")) {
        return {
          effective_plan_tier: "team",
          included_active_users: 25,
          hard_cap_active_users: null,
          active_user_window_days: 30,
          overage_enabled: 1,
          is_enabled: 1,
          metadata_json: null
        };
      }
      return null;
    });

    const gate = await evaluateFreeTierAiSpendGateForTaskWrite({
      env: { DB: db as unknown as D1Database, FREE_TIER_MONTHLY_AI_CAP_USD: "10" },
      organizationId: "org_0",
      workspaceId: "ws_1",
      nowIso: "2026-05-14T20:00:00.000Z"
    });

    expect(gate.allowed).toBe(true);
    expect(gate.policy.planTier).toBe("team");
  });
});
