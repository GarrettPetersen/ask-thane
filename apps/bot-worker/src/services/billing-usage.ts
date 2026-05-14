import type { BotEnv } from "./task-inference";

interface DailyUsageRow {
  organizationId: string;
  workspaceId: string;
  usageDate: string;
  metricName: string;
  quantity: number;
}

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
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

  const workspaces = await env.DB
    .prepare(`SELECT id AS workspace_id, organization_id FROM workspaces`)
    .all<Record<string, unknown>>();

  const rowsWritten: DailyUsageRow[] = [];
  for (const ws of workspaces.results ?? []) {
    const workspaceId = String(ws.workspace_id);
    const organizationId = String(ws.organization_id);

    const [activeUsersRow, channelsRow, taskEventsRow] = await Promise.all([
      env.DB
        .prepare(
          `SELECT COUNT(DISTINCT assignee_id) AS active_users
           FROM tasks
           WHERE organization_id = ?
             AND workspace_id = ?
             AND created_at >= ?
             AND created_at <= ?`
        )
        .bind(organizationId, workspaceId, dayStart, dayEnd)
        .first<Record<string, unknown>>(),
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
        .first<Record<string, unknown>>()
    ]);

    const usageRows: DailyUsageRow[] = [
      {
        organizationId,
        workspaceId,
        usageDate: date,
        metricName: "active_users",
        quantity: Number(activeUsersRow?.active_users ?? 0)
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

    const envName = metricEnvName(metricName);
    const meterName = envName ? (env as unknown as Record<string, string | undefined>)[envName] : undefined;
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
