interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function jsonWithCache(body: unknown, cacheControl: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl
    }
  });
}

function normalizeField(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLen);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeDaysParam(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return 180;
  }
  return Math.max(30, Math.min(365, parsed));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isoMidnight(daysAgo: number): string {
  const now = new Date();
  const utcDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  return `${isoDate(utcDate)}T00:00:00.000Z`;
}

function buildDateRange(startIsoDate: string, endIsoDate: string): string[] {
  const result: string[] = [];
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  const end = new Date(`${endIsoDate}T00:00:00.000Z`);
  for (let current = start; current <= end; current = new Date(current.valueOf() + 24 * 60 * 60 * 1000)) {
    result.push(isoDate(current));
  }
  return result;
}

async function fetchNewAndCumulativeSeries(input: {
  env: Env;
  table:
    | "organizations"
    | "workspaces"
    | "users"
    | "tasks"
    | "slack_workspace_installs"
    | "thane_cli_workspaces"
    | "thane_cli_accounts"
    | "thane_cli_messages";
  dateColumn: "created_at" | "installed_at";
  sinceIso: string;
  dates: string[];
}): Promise<{ dailyNew: number[]; cumulative: number[] }> {
  const baselineRow = await input.env.DB
    .prepare(`SELECT COUNT(*) AS count_before FROM ${input.table} WHERE ${input.dateColumn} < ?`)
    .bind(input.sinceIso)
    .first<{ count_before?: number }>();
  const groupedRows = await input.env.DB
    .prepare(
      `SELECT substr(${input.dateColumn}, 1, 10) AS day, COUNT(*) AS new_count
       FROM ${input.table}
       WHERE ${input.dateColumn} >= ?
       GROUP BY substr(${input.dateColumn}, 1, 10)
       ORDER BY day ASC`
    )
    .bind(input.sinceIso)
    .all<{ day?: string; new_count?: number }>();

  const byDate = new Map<string, number>();
  for (const row of groupedRows.results ?? []) {
    if (!row.day) {
      continue;
    }
    byDate.set(row.day, Number(row.new_count ?? 0));
  }
  const dailyNew = input.dates.map((date) => byDate.get(date) ?? 0);
  const cumulative: number[] = [];
  let running = Number(baselineRow?.count_before ?? 0);
  for (const value of dailyNew) {
    running += value;
    cumulative.push(running);
  }
  return { dailyNew, cumulative };
}

async function fetchOptionalCount(env: Env, table: "thane_cli_workspaces" | "thane_cli_accounts" | "thane_cli_messages"): Promise<number> {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count?: number }>();
    return Number(row?.count ?? 0);
  } catch (_error) {
    return 0;
  }
}

async function fetchOptionalSeries(input: {
  env: Env;
  table: "thane_cli_workspaces" | "thane_cli_accounts" | "thane_cli_messages";
  sinceIso: string;
  dates: string[];
}): Promise<{ dailyNew: number[]; cumulative: number[] }> {
  try {
    return await fetchNewAndCumulativeSeries({
      env: input.env,
      table: input.table,
      dateColumn: "created_at",
      sinceIso: input.sinceIso,
      dates: input.dates
    });
  } catch (_error) {
    return {
      dailyNew: input.dates.map(() => 0),
      cumulative: input.dates.map(() => 0)
    };
  }
}

async function handlePublicMetrics(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const days = normalizeDaysParam(url.searchParams.get("days"));
  const sinceIso = isoMidnight(days - 1);
  const startDate = sinceIso.slice(0, 10);
  const endDate = isoDate(new Date());
  const dates = buildDateRange(startDate, endDate);

  const [
    topline,
    thaneCliWorkspaces,
    thaneCliAccounts,
    thaneCliMessages,
    organizationsSeries,
    workspacesSeries,
    usersSeries,
    tasksSeries,
    installsSeries,
    thaneCliWorkspacesSeries,
    thaneCliAccountsSeries,
    thaneCliMessagesSeries
  ] = await Promise.all([
    env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM organizations) AS organizations,
           (SELECT COUNT(*) FROM workspaces) AS workspaces,
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM tasks) AS tasks,
           (SELECT COUNT(*) FROM slack_workspace_installs) AS installs`
      )
      .first<Record<string, unknown>>(),
    fetchOptionalCount(env, "thane_cli_workspaces"),
    fetchOptionalCount(env, "thane_cli_accounts"),
    fetchOptionalCount(env, "thane_cli_messages"),
    fetchNewAndCumulativeSeries({
      env,
      table: "organizations",
      dateColumn: "created_at",
      sinceIso,
      dates
    }),
    fetchNewAndCumulativeSeries({
      env,
      table: "workspaces",
      dateColumn: "created_at",
      sinceIso,
      dates
    }),
    fetchNewAndCumulativeSeries({
      env,
      table: "users",
      dateColumn: "created_at",
      sinceIso,
      dates
    }),
    fetchNewAndCumulativeSeries({
      env,
      table: "tasks",
      dateColumn: "created_at",
      sinceIso,
      dates
    }),
    fetchNewAndCumulativeSeries({
      env,
      table: "slack_workspace_installs",
      dateColumn: "installed_at",
      sinceIso,
      dates
    }),
    fetchOptionalSeries({
      env,
      table: "thane_cli_workspaces",
      sinceIso,
      dates
    }),
    fetchOptionalSeries({
      env,
      table: "thane_cli_accounts",
      sinceIso,
      dates
    }),
    fetchOptionalSeries({
      env,
      table: "thane_cli_messages",
      sinceIso,
      dates
    })
  ]);

  return jsonWithCache(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      range: {
        days,
        startDate,
        endDate
      },
      summary: {
        organizations: Number(topline?.organizations ?? 0),
        workspaces: Number(topline?.workspaces ?? 0),
        users: Number(topline?.users ?? 0),
        tasks: Number(topline?.tasks ?? 0),
        installs: Number(topline?.installs ?? 0),
        thaneCli: {
          workspaces: thaneCliWorkspaces,
          accounts: thaneCliAccounts,
          messages: thaneCliMessages
        }
      },
      series: {
        dates,
        organizations: organizationsSeries,
        workspaces: workspacesSeries,
        users: usersSeries,
        tasks: tasksSeries,
        installs: installsSeries,
        thaneCliWorkspaces: thaneCliWorkspacesSeries,
        thaneCliAccounts: thaneCliAccountsSeries,
        thaneCliMessages: thaneCliMessagesSeries
      }
    },
    "public, max-age=60"
  );
}

async function handleWaitlistSignup(request: Request, env: Env): Promise<Response> {
  let email: string | null = null;
  let name: string | null = null;
  let company: string | null = null;
  let notes: string | null = null;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await request.json()) as Record<string, unknown>;
    email = normalizeField(payload.email, 320);
    name = normalizeField(payload.name, 120);
    company = normalizeField(payload.company, 120);
    notes = normalizeField(payload.notes, 1500);
  } else {
    const form = await request.formData();
    email = normalizeField(form.get("email"), 320);
    name = normalizeField(form.get("name"), 120);
    company = normalizeField(form.get("company"), 120);
    notes = normalizeField(form.get("notes"), 1500);
  }

  if (!email || !isValidEmail(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  const nowIso = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO waitlist_signups (
         id, email, name, company, notes, source, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'landing_page', 'new', ?, ?)
       ON CONFLICT(email)
       DO UPDATE SET
         name = excluded.name,
         company = excluded.company,
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    )
    .bind(crypto.randomUUID(), email, name, company, notes, nowIso, nowIso)
    .run();

  return json({
    ok: true,
    message: "Thanks, you're on the Ask Thane waitlist.",
    contact: "garrett@askthane.com"
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isChatHost = url.hostname === "chat.askthane.com";

    if (url.pathname === "/health") {
      return json({ ok: true, service: "ask-thane-landing" }, 200);
    }

    if (url.pathname === "/api/public-metrics" && request.method === "GET") {
      return handlePublicMetrics(request, env);
    }

    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return handleWaitlistSignup(request, env);
    }

    if (isChatHost && (request.method === "GET" || request.method === "HEAD") && !url.pathname.includes(".")) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/chat-app.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/dashboard") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/dashboard.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/install") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/install.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/chat") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/chat.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/chat/install") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/chat-install.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/ask-thane") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/ask-thane.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    if (url.pathname === "/ask-thane/install") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/ask-thane-install.html";
      const assetRequest = new Request(assetUrl.toString(), request);
      return env.ASSETS.fetch(assetRequest);
    }

    return env.ASSETS.fetch(request);
  }
};
