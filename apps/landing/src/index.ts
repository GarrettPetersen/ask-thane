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

    if (url.pathname === "/health") {
      return json({ ok: true, service: "ask-thane-landing" }, 200);
    }

    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return handleWaitlistSignup(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
