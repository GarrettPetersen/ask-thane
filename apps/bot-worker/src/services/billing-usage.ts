import type { BotEnv } from "./task-inference";
import {
  countBillableActiveUsersForWorkspace,
  estimateWorkspaceMonthlyBill,
  resolveWorkspaceBillingPolicy
} from "./billing-policy";

interface DailyUsageRow {
  organizationId: string;
  workspaceId: string;
  usageDate: string;
  metricName: string;
  quantity: number;
}

interface OpenAiCostBucketResult {
  amount?: {
    value?: number;
    currency?: string;
  };
}

interface OpenAiCostBucket {
  start_time?: number;
  end_time?: number;
  results?: OpenAiCostBucketResult[];
}

interface OpenAiCostsResponse {
  data?: OpenAiCostBucket[];
}

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toUtcDayBounds(usageDate: string): {
  dayStartIso: string;
  dayEndIso: string;
  startUnixSeconds: number;
  endUnixSeconds: number;
} {
  const start = new Date(`${usageDate}T00:00:00.000Z`);
  const end = new Date(start.valueOf() + 24 * 60 * 60 * 1000);
  return {
    dayStartIso: start.toISOString(),
    dayEndIso: new Date(end.valueOf() - 1).toISOString(),
    startUnixSeconds: Math.floor(start.valueOf() / 1000),
    endUnixSeconds: Math.floor(end.valueOf() / 1000)
  };
}

function toUtcMonthBounds(month: string): { startIso: string; endIso: string } {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const nextMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return {
    startIso: start.toISOString(),
    endIso: new Date(nextMonth.valueOf() - 1).toISOString()
  };
}

function isoMonthOnly(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function clampThresholdRatio(raw: string | undefined): number {
  const fallback = 0.1;
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) {
    return 0;
  }
  if (parsed <= 1) {
    return parsed;
  }
  return Math.min(parsed / 100, 1);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function upsertDailyUsage(env: BotEnv, row: DailyUsageRow): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO usage_daily_aggregates (
         id, organization_id, workspace_id, usage_date, metric_name, quantity, source_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, workspace_id, usage_date, metric_name)
       DO UPDATE SET
         quantity = excluded.quantity,
         source_json = excluded.source_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      row.organizationId,
      row.workspaceId,
      row.usageDate,
      row.metricName,
      row.quantity,
      JSON.stringify({ source: "bot_usage_aggregator" }),
      nowIso,
      nowIso
    )
    .run();
}

export async function aggregateDailyUsage(env: BotEnv, usageDate?: string): Promise<Record<string, unknown>> {
  const date = usageDate ?? isoDateOnly(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const monthStart = `${date.slice(0, 7)}-01T00:00:00.000Z`;
  const prevDayEnd = new Date(new Date(dayStart).valueOf() - 1).toISOString();
  const hasPrevDayInMonth = prevDayEnd >= monthStart;

  const workspaces = await env.DB
    .prepare(`SELECT id AS workspace_id, organization_id FROM workspaces`)
    .all<Record<string, unknown>>();

  const rowsWritten: DailyUsageRow[] = [];
  for (const ws of workspaces.results ?? []) {
    const workspaceId = String(ws.workspace_id);
    const organizationId = String(ws.organization_id);
    const policy = await resolveWorkspaceBillingPolicy({
      env,
      organizationId,
      workspaceId
    });

    const [activeUsers, channelsRow, taskEventsRow, llmCostRow, llmMtdRow, llmPrevMtdRow] = await Promise.all([
      countBillableActiveUsersForWorkspace({
        env,
        organizationId,
        workspaceId,
        asOfIso: dayEnd,
        activeWindowDays: policy.activeUserWindowDays
      }),
      env.DB
        .prepare(
          `SELECT COUNT(DISTINCT conversation_source_id) AS active_channels
           FROM ingest_events
           WHERE organization_id = ?
             AND conversation_source_id IN (
               SELECT id
               FROM conversation_sources
               WHERE organization_id = ?
                 AND workspace_id = ?
             )
             AND received_at >= ?
             AND received_at <= ?`
        )
        .bind(organizationId, organizationId, workspaceId, dayStart, dayEnd)
        .first<Record<string, unknown>>(),
      env.DB
        .prepare(
          `SELECT COUNT(*) AS task_events
           FROM task_actions
           WHERE organization_id = ?
             AND workspace_id = ?
             AND created_at >= ?
             AND created_at <= ?`
        )
        .bind(organizationId, workspaceId, dayStart, dayEnd)
        .first<Record<string, unknown>>(),
      env.DB
        .prepare(
          `SELECT
             COUNT(*) AS llm_calls,
             COALESCE(SUM(total_cost_usd), 0) AS llm_cost_usd
           FROM llm_usage_events
           WHERE organization_id = ?
             AND workspace_id = ?
             AND created_at >= ?
             AND created_at <= ?`
        )
        .bind(organizationId, workspaceId, dayStart, dayEnd)
        .first<Record<string, unknown>>(),
      env.DB
        .prepare(
          `SELECT COALESCE(SUM(total_cost_usd), 0) AS llm_cost_usd_mtd
           FROM llm_usage_events
           WHERE organization_id = ?
             AND workspace_id = ?
             AND created_at >= ?
             AND created_at <= ?`
        )
        .bind(organizationId, workspaceId, monthStart, dayEnd)
        .first<Record<string, unknown>>(),
      hasPrevDayInMonth
        ? env.DB
            .prepare(
              `SELECT COALESCE(SUM(total_cost_usd), 0) AS llm_cost_usd_mtd_prev
               FROM llm_usage_events
               WHERE organization_id = ?
                 AND workspace_id = ?
                 AND created_at >= ?
                 AND created_at <= ?`
            )
            .bind(organizationId, workspaceId, monthStart, prevDayEnd)
            .first<Record<string, unknown>>()
        : Promise.resolve({ llm_cost_usd_mtd_prev: 0 } as Record<string, unknown>)
    ]);
    const llmCostMtd = Number(llmMtdRow?.llm_cost_usd_mtd ?? 0);
    const llmCostMtdPrev = Number(llmPrevMtdRow?.llm_cost_usd_mtd_prev ?? 0);
    const aiOverageMtd = Math.max(llmCostMtd - policy.includedAiCostUsd, 0) * policy.aiOverageMultiplier;
    const aiOverageMtdPrev = Math.max(llmCostMtdPrev - policy.includedAiCostUsd, 0) * policy.aiOverageMultiplier;
    const aiOverageUsdDaily = roundUsd(Math.max(aiOverageMtd - aiOverageMtdPrev, 0));

    const usageRows: DailyUsageRow[] = [
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "active_users",
        quantity: activeUsers
      },
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "active_channels",
        quantity: Number(channelsRow?.active_channels ?? 0)
      },
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "task_events",
        quantity: Number(taskEventsRow?.task_events ?? 0)
      },
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "llm_cost_usd",
        quantity: Number(llmCostRow?.llm_cost_usd ?? 0)
      },
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "ai_overage_usd",
        quantity: aiOverageUsdDaily
      },
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "llm_calls",
        quantity: Number(llmCostRow?.llm_calls ?? 0)
      }
    ];

    for (const row of usageRows) {
      await upsertDailyUsage(env, row);
      rowsWritten.push(row);
    }
  }

  return {
    ok: true,
    usageDate: date,
    rowsWritten: rowsWritten.length,
    rows: rowsWritten
  };
}

function metricEnvName(metricName: string): string {
  switch (metricName) {
    case "active_users":
      return "STRIPE_METER_NAME_ACTIVE_USERS";
    case "active_channels":
      return "STRIPE_METER_NAME_ACTIVE_CHANNELS";
    case "task_events":
      return "STRIPE_METER_NAME_TASK_EVENTS";
    case "llm_cost_usd":
      return "STRIPE_METER_NAME_LLM_COST_USD";
    case "ai_overage_usd":
      return "STRIPE_METER_NAME_AI_OVERAGE_USD";
    default:
      return "";
  }
}

function metricNameToCustomerKey(metricName: string): string {
  return `workspace:${metricName}`;
}

export async function syncUsageToStripe(env: BotEnv, usageDate?: string): Promise<Record<string, unknown>> {
  const date = usageDate ?? isoDateOnly(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, error: "missing_stripe_secret_key" };
  }

  const rows = await env.DB
    .prepare(
      `SELECT organization_id, workspace_id, usage_date, metric_name, quantity
       FROM usage_daily_aggregates
       WHERE usage_date = ?`
    )
    .bind(date)
    .all<Record<string, unknown>>();

  let attempted = 0;
  let sent = 0;
  const failures: Array<Record<string, unknown>> = [];

  for (const raw of rows.results ?? []) {
    const organizationId = String(raw.organization_id);
    const workspaceId = String(raw.workspace_id);
    const metricName = String(raw.metric_name);
    const quantity = Number(raw.quantity ?? 0);
    if (metricName === "llm_cost_usd") {
      // Keep raw LLM cost for internal reporting; bill Stripe from ai_overage_usd instead.
      continue;
    }

    const envName = metricEnvName(metricName);
    let meterName = envName ? (env as unknown as Record<string, string | undefined>)[envName] : undefined;
    if (!meterName && metricName === "ai_overage_usd") {
      meterName = env.STRIPE_METER_NAME_LLM_COST_USD;
    }
    if (!meterName) {
      continue;
    }

    attempted += 1;
    const identifier = `${organizationId}:${workspaceId}`;
    const eventName = meterName;
    const timestamp = Math.floor(new Date(`${date}T23:59:59.000Z`).valueOf() / 1000);

    const body = new URLSearchParams({
      event_name: eventName,
      "payload[value]": String(quantity),
      "payload[stripe_customer_id]": identifier,
      "payload[timestamp]": String(timestamp),
      identifier: `${workspaceId}:${metricNameToCustomerKey(metricName)}:${date}`
    });

    const response = await fetch("https://api.stripe.com/v1/billing/meter_events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      const text = await response.text();
      failures.push({ workspaceId, metricName, status: response.status, body: text.slice(0, 500) });
      continue;
    }

    sent += 1;
  }

  return {
    ok: failures.length === 0,
    usageDate: date,
    attempted,
    sent,
    failures
  };
}

export async function getUsageStatus(env: BotEnv): Promise<Record<string, unknown>> {
  const rows = await env.DB
    .prepare(
      `SELECT organization_id, workspace_id, usage_date, metric_name, quantity, updated_at
       FROM usage_daily_aggregates
       ORDER BY usage_date DESC, updated_at DESC
       LIMIT 200`
    )
    .all<Record<string, unknown>>();

  return {
    ok: true,
    rows: rows.results ?? []
  };
}

async function fetchOpenAiActualCostForDate(input: {
  env: BotEnv;
  usageDate: string;
}): Promise<
  | {
      ok: true;
      costUsd: number;
      currency: string;
      requestId?: string;
      raw: OpenAiCostsResponse;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      body?: string;
    }
> {
  const authToken = input.env.OPENAI_ADMIN_API_KEY ?? input.env.OPENAI_API_KEY;
  if (!authToken) {
    return { ok: false, error: "missing_openai_admin_api_key" };
  }

  const bounds = toUtcDayBounds(input.usageDate);
  const params = new URLSearchParams({
    start_time: String(bounds.startUnixSeconds),
    end_time: String(bounds.endUnixSeconds),
    bucket_width: "1d",
    limit: "7"
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json"
  };
  if (input.env.OPENAI_ORGANIZATION_ID?.trim()) {
    headers["OpenAI-Organization"] = input.env.OPENAI_ORGANIZATION_ID.trim();
  }

  const response = await fetch(`https://api.openai.com/v1/organization/costs?${params.toString()}`, {
    method: "GET",
    headers
  });
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const jsonText = await response.text();
  let payload: OpenAiCostsResponse = {};
  try {
    payload = JSON.parse(jsonText) as OpenAiCostsResponse;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    return {
      ok: false,
      error: "openai_costs_fetch_failed",
      status: response.status,
      body: jsonText.slice(0, 800)
    };
  }

  const buckets = Array.isArray(payload.data) ? payload.data : [];
  const costUsd = buckets.reduce((bucketTotal, bucket) => {
    const results = Array.isArray(bucket.results) ? bucket.results : [];
    const bucketCost = results.reduce((sum, result) => {
      const amount = result.amount;
      if (!amount) {
        return sum;
      }
      const currency = String(amount.currency ?? "usd").toLowerCase();
      if (currency !== "usd") {
        return sum;
      }
      return sum + asNumber(amount.value);
    }, 0);
    return bucketTotal + bucketCost;
  }, 0);

  return {
    ok: true,
    costUsd,
    currency: "usd",
    ...(requestId ? { requestId } : {}),
    raw: payload
  };
}

export async function syncOpenAiCostReconciliation(env: BotEnv, usageDate?: string): Promise<Record<string, unknown>> {
  if ((env.OPENAI_COST_RECONCILIATION_ENABLED ?? "true").toLowerCase() === "false") {
    return { ok: true, disabled: true, reason: "openai_cost_reconciliation_disabled" };
  }

  const date = usageDate ?? isoDateOnly(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const bounds = toUtcDayBounds(date);

  const actual = await fetchOpenAiActualCostForDate({ env, usageDate: date });
  if (!actual.ok) {
    return actual;
  }

  const estimatedRow = await env.DB
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS estimated_cost_usd
       FROM llm_usage_events
       WHERE created_at >= ?
         AND created_at <= ?`
    )
    .bind(bounds.dayStartIso, bounds.dayEndIso)
    .first<Record<string, unknown>>();
  const estimatedCostUsd = asNumber(estimatedRow?.estimated_cost_usd);
  const actualCostUsd = asNumber(actual.costUsd);
  const varianceCostUsd = actualCostUsd - estimatedCostUsd;

  const varianceRatio =
    actualCostUsd === 0 ? (estimatedCostUsd === 0 ? 0 : null) : varianceCostUsd / actualCostUsd;
  const thresholdRatio = clampThresholdRatio(env.OPENAI_RECON_ALERT_THRESHOLD_PCT);
  const alertTriggered =
    varianceRatio === null ? Math.abs(varianceCostUsd) > 0 : Math.abs(varianceRatio) >= thresholdRatio;
  const nowIso = new Date().toISOString();

  await env.DB
    .prepare(
      `INSERT INTO openai_cost_reconciliation_daily (
         id, usage_date, estimated_cost_usd, actual_cost_usd, variance_cost_usd, variance_ratio,
         alert_threshold_ratio, alert_triggered, alerted_at, currency, openai_request_id, source_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(usage_date)
       DO UPDATE SET
         estimated_cost_usd = excluded.estimated_cost_usd,
         actual_cost_usd = excluded.actual_cost_usd,
         variance_cost_usd = excluded.variance_cost_usd,
         variance_ratio = excluded.variance_ratio,
         alert_threshold_ratio = excluded.alert_threshold_ratio,
         alert_triggered = excluded.alert_triggered,
         alerted_at = excluded.alerted_at,
         currency = excluded.currency,
         openai_request_id = excluded.openai_request_id,
         source_json = excluded.source_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      date,
      estimatedCostUsd,
      actualCostUsd,
      varianceCostUsd,
      varianceRatio,
      thresholdRatio,
      alertTriggered ? 1 : 0,
      alertTriggered ? nowIso : null,
      "usd",
      actual.requestId ?? null,
      JSON.stringify(actual.raw),
      nowIso,
      nowIso
    )
    .run();

  if (alertTriggered) {
    console.warn("openai_cost_reconciliation_variance_alert", {
      usageDate: date,
      estimatedCostUsd,
      actualCostUsd,
      varianceCostUsd,
      varianceRatio,
      thresholdRatio
    });
  }

  return {
    ok: true,
    usageDate: date,
    estimatedCostUsd,
    actualCostUsd,
    varianceCostUsd,
    varianceRatio,
    thresholdRatio,
    alertTriggered
  };
}

export async function getOpenAiCostReconciliationStatus(env: BotEnv): Promise<Record<string, unknown>> {
  const rows = await env.DB
    .prepare(
      `SELECT usage_date, estimated_cost_usd, actual_cost_usd, variance_cost_usd, variance_ratio,
              alert_threshold_ratio, alert_triggered, alerted_at, currency, openai_request_id, updated_at
       FROM openai_cost_reconciliation_daily
       ORDER BY usage_date DESC
       LIMIT 90`
    )
    .all<Record<string, unknown>>();

  return {
    ok: true,
    rows: rows.results ?? []
  };
}

export async function getWorkspaceBillingPreview(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  month?: string;
}): Promise<Record<string, unknown>> {
  const month = input.month ?? isoMonthOnly(new Date());
  const bounds = toUtcMonthBounds(month);
  const estimate = await estimateWorkspaceMonthlyBill({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    monthStartIso: bounds.startIso,
    monthEndIso: bounds.endIso
  });

  return {
    ok: true,
    month,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ...estimate
  };
}

export async function getBillingPreviewStatus(env: BotEnv, month?: string): Promise<Record<string, unknown>> {
  const targetMonth = month ?? isoMonthOnly(new Date());
  const bounds = toUtcMonthBounds(targetMonth);
  const workspaces = await env.DB
    .prepare(
      `SELECT w.id AS workspace_id, w.organization_id
       FROM workspaces w
       ORDER BY w.organization_id, w.id`
    )
    .all<Record<string, unknown>>();

  const rows = await Promise.all(
    (workspaces.results ?? []).map(async (ws) => {
      const organizationId = String(ws.organization_id);
      const workspaceId = String(ws.workspace_id);
      const estimate = await estimateWorkspaceMonthlyBill({
        env,
        organizationId,
        workspaceId,
        monthStartIso: bounds.startIso,
        monthEndIso: bounds.endIso
      });
      return {
        month: targetMonth,
        organizationId,
        workspaceId,
        ...estimate
      };
    })
  );

  return {
    ok: true,
    month: targetMonth,
    rows
  };
}
