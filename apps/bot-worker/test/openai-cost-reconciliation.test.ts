import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOpenAiCostReconciliationStatus, syncOpenAiCostReconciliation } from "../src/services/billing-usage";

function makeReconDbStub(input: {
  estimatedCostUsd?: number;
  statusRows?: Array<Record<string, unknown>>;
}) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn(async () => {
      if (sql.includes("FROM openai_cost_reconciliation_daily")) {
        return { results: input.statusRows ?? [] };
      }
      return { results: [] };
    }),
    bind: (..._args: unknown[]) => ({
      run,
      first: vi.fn(async () => {
        if (sql.includes("SUM(total_cost_usd)")) {
          return { estimated_cost_usd: input.estimatedCostUsd ?? 0 };
        }
        return null;
      }),
      all: vi.fn(async () => ({ results: [] }))
    })
  }));
  return { prepare, run };
}

describe("openai cost reconciliation", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns error when admin key is missing", async () => {
    const db = makeReconDbStub({});
    const result = await syncOpenAiCostReconciliation(
      {
        DB: db as unknown as D1Database
      },
      "2026-05-14"
    );
    expect(result).toMatchObject({ ok: false, error: "missing_openai_admin_api_key" });
  });

  it("returns disabled when reconciliation is turned off", async () => {
    const db = makeReconDbStub({});
    const result = await syncOpenAiCostReconciliation(
      {
        DB: db as unknown as D1Database,
        OPENAI_COST_RECONCILIATION_ENABLED: "false"
      },
      "2026-05-14"
    );
    expect(result).toMatchObject({ ok: true, disabled: true, reason: "openai_cost_reconciliation_disabled" });
  });

  it("reconciles estimate vs actual and raises variance alert", async () => {
    const db = makeReconDbStub({ estimatedCostUsd: 8 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            object: "page",
            data: [
              {
                object: "bucket",
                start_time: 1747180800,
                end_time: 1747267200,
                results: [
                  {
                    object: "organization.costs.result",
                    amount: { value: 10, currency: "usd" },
                    line_item: null,
                    project_id: null
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { "x-request-id": "req_recon_1" } }
        );
      })
    );

    const result = await syncOpenAiCostReconciliation(
      {
        DB: db as unknown as D1Database,
        OPENAI_ADMIN_API_KEY: "admin-key",
        OPENAI_RECON_ALERT_THRESHOLD_PCT: "10"
      },
      "2026-05-14"
    );

    expect(result).toMatchObject({
      ok: true,
      usageDate: "2026-05-14",
      estimatedCostUsd: 8,
      actualCostUsd: 10,
      varianceCostUsd: 2,
      alertTriggered: true
    });
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "openai_cost_reconciliation_variance_alert",
      expect.objectContaining({
        usageDate: "2026-05-14",
        estimatedCostUsd: 8,
        actualCostUsd: 10
      })
    );
  });

  it("reads reconciliation status rows", async () => {
    const db = makeReconDbStub({
      statusRows: [{ usage_date: "2026-05-14", estimated_cost_usd: 1.23, actual_cost_usd: 1.2 }]
    });

    const result = await getOpenAiCostReconciliationStatus({
      DB: db as unknown as D1Database
    });

    expect(result).toEqual({
      ok: true,
      rows: [{ usage_date: "2026-05-14", estimated_cost_usd: 1.23, actual_cost_usd: 1.2 }]
    });
  });
});
