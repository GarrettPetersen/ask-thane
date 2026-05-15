import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateDailyUsage,
  getBillingPreviewStatus,
  getUsageStatus,
  getWorkspaceBillingPreview,
  syncUsageToStripe
} from "../src/services/billing-usage";
import {
  countBillableActiveUsersForWorkspace,
  estimateWorkspaceMonthlyBill,
  resolveWorkspaceBillingPolicy
} from "../src/services/billing-policy";

vi.mock("../src/services/billing-policy", () => ({
  resolveWorkspaceBillingPolicy: vi.fn(async () => ({
    planTier: "team",
    monthlyBasePriceUsd: 99,
    includedActiveUsers: 25,
    perUserOverageUsd: 3,
    includedAiCostUsd: 20,
    aiOverageMultiplier: 1.35,
    hardCapActiveUsers: null,
    activeUserWindowDays: 30,
    overageEnabled: true,
    isEnabled: true
  })),
  countBillableActiveUsersForWorkspace: vi.fn(async () => 5),
  estimateWorkspaceMonthlyBill: vi.fn(async () => ({
    policy: {
      planTier: "team",
      monthlyBasePriceUsd: 99,
      includedActiveUsers: 25,
      perUserOverageUsd: 3,
      includedAiCostUsd: 20,
      aiOverageMultiplier: 1.35,
      hardCapActiveUsers: null,
      activeUserWindowDays: 30,
      overageEnabled: true,
      isEnabled: true
    },
    activeUsers: 5,
    participantOverageUsers: 0,
    participantOverageUsd: 0,
    aiEstimatedCostUsd: 2,
    aiOverageUsd: 0,
    monthlyBasePriceUsd: 99,
    estimatedMonthlyTotalUsd: 99
  }))
}));

function makeDbStub(input: {
  workspaces?: Array<Record<string, unknown>>;
  usageRows?: Array<Record<string, unknown>>;
  statusRows?: Array<Record<string, unknown>>;
  channelsRow?: Record<string, unknown>;
  taskEventsRow?: Record<string, unknown>;
  llmRow?: Record<string, unknown>;
}) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn(async () => {
      if (sql.includes("FROM workspaces")) {
        return { results: input.workspaces ?? [] };
      }
      if (sql.includes("FROM usage_daily_aggregates") && sql.includes("WHERE usage_date")) {
        return { results: input.usageRows ?? [] };
      }
      if (sql.includes("FROM usage_daily_aggregates") && sql.includes("ORDER BY usage_date DESC")) {
        return { results: input.statusRows ?? [] };
      }
      return { results: [] };
    }),
    bind: (..._args: unknown[]) => ({
      run,
      all: vi.fn(async () => ({ results: input.usageRows ?? [] })),
      first: vi.fn(async () => {
        if (sql.includes("COUNT(DISTINCT conversation_source_id) AS active_channels")) {
          return input.channelsRow ?? { active_channels: 0 };
        }
        if (sql.includes("COUNT(*) AS task_events")) {
          return input.taskEventsRow ?? { task_events: 0 };
        }
        if (sql.includes("COUNT(*) AS llm_calls")) {
          return input.llmRow ?? { llm_calls: 0, llm_cost_usd: 0 };
        }
        return null;
      })
    })
  }));

  return { prepare, run };
}

describe("billing usage services", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aggregateDailyUsage writes expected rows", async () => {
    const db = makeDbStub({
      workspaces: [{ workspace_id: "ws_1", organization_id: "org_0" }],
      channelsRow: { active_channels: 2 },
      taskEventsRow: { task_events: 3 },
      llmRow: { llm_calls: 4, llm_cost_usd: 1.25 }
    });

    const result = await aggregateDailyUsage({ DB: db as unknown as D1Database }, "2026-05-14");

    expect(result).toMatchObject({ ok: true, rowsWritten: 6, usageDate: "2026-05-14" });
    const rowMetrics = (result as { rows?: Array<{ metricName: string }> }).rows?.map((row) => row.metricName) ?? [];
    expect(rowMetrics).toContain("ai_overage_usd");
    expect(resolveWorkspaceBillingPolicy).toHaveBeenCalledTimes(1);
    expect(countBillableActiveUsersForWorkspace).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(6);
  });

  it("syncUsageToStripe returns missing key error", async () => {
    const db = makeDbStub({});

    const result = await syncUsageToStripe({ DB: db as unknown as D1Database }, "2026-05-14");

    expect(result).toEqual({ ok: false, error: "missing_stripe_secret_key" });
  });

  it("syncUsageToStripe sends configured meter events and reports failures", async () => {
    const db = makeDbStub({
      usageRows: [
        {
          organization_id: "org_0",
          workspace_id: "ws_1",
          usage_date: "2026-05-14",
          metric_name: "active_users",
          quantity: 5
        },
        {
          organization_id: "org_0",
          workspace_id: "ws_1",
          usage_date: "2026-05-14",
          metric_name: "ai_overage_usd",
          quantity: 2.2
        }
      ]
    });

    const fetchMock = vi
      .fn(async () => new Response("ok", { status: 200 }))
      .mockImplementationOnce(async () => new Response("bad", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncUsageToStripe(
      {
        DB: db as unknown as D1Database,
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_METER_NAME_ACTIVE_USERS: "meter_active_users",
        STRIPE_METER_NAME_AI_OVERAGE_USD: "meter_ai_overage"
      },
      "2026-05-14"
    );

    expect(result).toMatchObject({
      ok: false,
      attempted: 2,
      sent: 1
    });
    expect(Array.isArray((result as { failures?: unknown[] }).failures)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("syncUsageToStripe can fall back ai_overage_usd to legacy llm meter var", async () => {
    const db = makeDbStub({
      usageRows: [
        {
          organization_id: "org_0",
          workspace_id: "ws_1",
          usage_date: "2026-05-14",
          metric_name: "llm_cost_usd",
          quantity: 9.9
        },
        {
          organization_id: "org_0",
          workspace_id: "ws_1",
          usage_date: "2026-05-14",
          metric_name: "ai_overage_usd",
          quantity: 1.5
        }
      ]
    });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncUsageToStripe(
      {
        DB: db as unknown as D1Database,
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_METER_NAME_LLM_COST_USD: "meter_legacy"
      },
      "2026-05-14"
    );

    expect(result).toMatchObject({ ok: true, attempted: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getUsageStatus returns aggregate rows", async () => {
    const db = makeDbStub({
      statusRows: [{ usage_date: "2026-05-14", metric_name: "active_users", quantity: 5 }]
    });

    const result = await getUsageStatus({ DB: db as unknown as D1Database });

    expect(result).toEqual({
      ok: true,
      rows: [{ usage_date: "2026-05-14", metric_name: "active_users", quantity: 5 }]
    });
  });

  it("getWorkspaceBillingPreview returns month-scoped estimate", async () => {
    const result = await getWorkspaceBillingPreview({
      env: { DB: {} as D1Database },
      organizationId: "org_0",
      workspaceId: "ws_1",
      month: "2026-05"
    });

    expect(result).toMatchObject({ ok: true, month: "2026-05", organizationId: "org_0", workspaceId: "ws_1" });
    expect(estimateWorkspaceMonthlyBill).toHaveBeenCalledTimes(1);
  });

  it("getBillingPreviewStatus returns rows for all workspaces", async () => {
    const db = makeDbStub({
      workspaces: [
        { workspace_id: "ws_1", organization_id: "org_0" },
        { workspace_id: "ws_2", organization_id: "org_0" }
      ]
    });

    const result = await getBillingPreviewStatus({ DB: db as unknown as D1Database }, "2026-05");

    expect(result).toMatchObject({ ok: true, month: "2026-05" });
    expect(Array.isArray((result as { rows?: unknown[] }).rows)).toBe(true);
    expect((result as { rows: unknown[] }).rows).toHaveLength(2);
    expect(estimateWorkspaceMonthlyBill).toHaveBeenCalledTimes(2);
  });
});
