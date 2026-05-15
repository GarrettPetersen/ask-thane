interface Env {
  DB?: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  THANE_BASE_URL?: string;
  STRIPE_PRICE_TEAM_MONTHLY?: string;
  STRIPE_PRICE_GROWTH_MONTHLY?: string;
  STRIPE_PRICE_SCALE_MONTHLY?: string;
  STRIPE_PRICE_SCALE_PLUS_MONTHLY?: string;
  BUILD_ENV?: string;
  BUILD_GIT_SHA?: string;
  BUILD_DEPLOYED_AT?: string;
}

type PlanTier = "team" | "growth" | "scale" | "scale_plus";

interface PlanConfig {
  planTier: PlanTier;
  label: string;
  monthlyPriceUsd: number;
  includedUsers: number;
  perUserOverageUsd: number;
  includedAiCreditUsd: number;
  priceEnvValue: string | undefined;
}

interface StripeEventPayload {
  id?: string;
  type?: string;
  data?: {
    object?: Record<string, unknown>;
  };
}

function parseStripeSignatureHeader(value: string): { timestamp: number; signatures: string[] } | null {
  const parts = value.split(",").map((entry) => entry.trim());
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, raw] = part.split("=", 2);
    if (!key || !raw) {
      continue;
    }
    if (key === "t") {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        timestamp = parsed;
      }
      continue;
    }
    if (key === "v1" && raw) {
      signatures.push(raw);
    }
  }
  if (!timestamp || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function computeHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const messageData = new TextEncoder().encode(payload);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, messageData);
  const bytes = new Uint8Array(signature);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignatureWithBody(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret?: string;
}): Promise<boolean> {
  const trimmedSecret = input.secret?.trim();
  if (!trimmedSecret || !input.signatureHeader) {
    return false;
  }
  const parsed = parseStripeSignatureHeader(input.signatureHeader);
  if (!parsed) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > 300) {
    return false;
  }
  const payload = `${parsed.timestamp}.${input.rawBody}`;
  const expected = await computeHmacSha256Hex(trimmedSecret, payload);
  return parsed.signatures.some((candidate) => timingSafeEqualHex(candidate, expected));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function normalizePlanTier(value: unknown): PlanTier | null {
  if (value === "team" || value === "growth" || value === "scale" || value === "scale_plus") {
    return value;
  }
  return null;
}

function asUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asSafeIdentifier(value: unknown): string | null {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length > 120) {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function planTierForOrganization(planTier: PlanTier): string {
  switch (planTier) {
    case "scale_plus":
      return "scale_plus";
    case "scale":
      return "scale";
    case "growth":
      return "growth";
    case "team":
      return "team";
    default:
      return "free";
  }
}

function planCatalog(env: Env): PlanConfig[] {
  return [
    {
      planTier: "team",
      label: "Team",
      monthlyPriceUsd: 99,
      includedUsers: 25,
      perUserOverageUsd: 3,
      includedAiCreditUsd: 20,
      priceEnvValue: env.STRIPE_PRICE_TEAM_MONTHLY
    },
    {
      planTier: "growth",
      label: "Growth",
      monthlyPriceUsd: 299,
      includedUsers: 100,
      perUserOverageUsd: 2,
      includedAiCreditUsd: 120,
      priceEnvValue: env.STRIPE_PRICE_GROWTH_MONTHLY
    },
    {
      planTier: "scale",
      label: "Scale",
      monthlyPriceUsd: 699,
      includedUsers: 300,
      perUserOverageUsd: 1.25,
      includedAiCreditUsd: 400,
      priceEnvValue: env.STRIPE_PRICE_SCALE_MONTHLY
    },
    {
      planTier: "scale_plus",
      label: "Scale Plus",
      monthlyPriceUsd: 1499,
      includedUsers: 1000,
      perUserOverageUsd: 1,
      includedAiCreditUsd: 1000,
      priceEnvValue: env.STRIPE_PRICE_SCALE_PLUS_MONTHLY
    }
  ];
}

function renderSubscribePage(env: Env, requestUrl: URL): string {
  const plans = planCatalog(env);
  const requestedPlanTier = normalizePlanTier(requestUrl.searchParams.get("plan_tier"));
  const autoStart = requestUrl.searchParams.get("autostart") === "1";
  const cards = plans
    .map(
      (plan) => `
        <article class="card${requestedPlanTier === plan.planTier ? " selected" : ""}">
          <h2>${plan.label}</h2>
          <div class="price">$${plan.monthlyPriceUsd}<span>/mo</span></div>
          <ul>
            <li>${plan.includedUsers} active users included</li>
            <li>$${plan.perUserOverageUsd}/user overage</li>
            <li>$${plan.includedAiCreditUsd} included monthly AI credit</li>
          </ul>
          <button data-plan="${plan.planTier}">Start ${plan.label}</button>
        </article>`
    )
    .join("");

  const defaultBase = (env.THANE_BASE_URL?.trim().replace(/\/$/, "") ?? "https://askthane.com").replace(/"/g, "");
  const currentOrigin = requestUrl.origin.replace(/"/g, "");
  const organizationId = requestUrl.searchParams.get("organization_id") ?? "";
  const workspaceId = requestUrl.searchParams.get("workspace_id") ?? "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ask Thane Pricing</title>
    <style>
      :root { --bg:#f7f3ea; --ink:#141414; --muted:#666; --card:#fffdf8; --line:#e7decd; --brand:#0f5fd7; --brand2:#0848a6; }
      * { box-sizing:border-box; }
      body { margin:0; font-family:"Avenir Next","Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
      main { width:min(1080px,100% - 2rem); margin:2rem auto 3rem; }
      h1 { margin:0 0 .5rem; font-size:clamp(2rem,5vw,3rem); }
      p { color:var(--muted); }
      .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); margin-top:1.25rem; }
      .card { border:1px solid var(--line); border-radius:14px; background:var(--card); padding:1rem; }
      .card.selected { border-color:#7aa8f0; box-shadow:0 10px 22px rgba(15,95,215,.14); }
      .price { font-size:2rem; font-weight:700; margin:.5rem 0; }
      .price span { font-size:.95rem; color:var(--muted); }
      ul { margin:.75rem 0 1rem; padding-left:1rem; color:var(--muted); }
      button { width:100%; border:0; border-radius:10px; padding:.75rem .8rem; font:inherit; font-weight:700; color:#fff; background:var(--brand); cursor:pointer; }
      button:hover { background:var(--brand2); }
      .status { margin-top:1rem; min-height:1.3rem; color:var(--muted); }
      .status.error { color:#b42318; }
    </style>
  </head>
  <body>
    <main>
      <h1>Choose a Thane plan</h1>
      <p>Plans include base seats plus usage-based overages for active users and AI spend.</p>
      <div class="grid">${cards}</div>
      <div id="status" class="status" aria-live="polite"></div>
    </main>
    <script>
      (() => {
        const statusEl = document.getElementById("status");
        const orgId = ${JSON.stringify(organizationId)};
        const workspaceId = ${JSON.stringify(workspaceId)};
        const requestedPlan = ${JSON.stringify(requestedPlanTier)};
        const autoStart = ${JSON.stringify(autoStart)};
        const successUrl = "${defaultBase}/billing/success?session_id={CHECKOUT_SESSION_ID}";
        const cancelUrl = "${currentOrigin}/subscribe?canceled=1";
        const setStatus = (text, isError) => {
          if (!statusEl) return;
          statusEl.textContent = text;
          statusEl.className = isError ? "status error" : "status";
        };
        const startCheckout = async (plan) => {
          if (!plan) return;
          setStatus("Redirecting to secure checkout...", false);
          try {
            const response = await fetch("/api/checkout/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                plan_tier: plan,
                success_url: successUrl,
                cancel_url: cancelUrl,
                organization_id: orgId || undefined,
                workspace_id: workspaceId || undefined
              })
            });
            const result = await response.json();
            if (!response.ok || !result.ok || !result.checkout_url) {
              throw new Error(result.error || "checkout_session_failed");
            }
            window.location.href = result.checkout_url;
          } catch (_error) {
            setStatus("Could not start checkout right now. Please contact support.", true);
          }
        };

        for (const button of document.querySelectorAll("button[data-plan]")) {
          button.addEventListener("click", async () => {
            const plan = button.getAttribute("data-plan");
            await startCheckout(plan);
          });
        }

        if (autoStart && requestedPlan) {
          startCheckout(requestedPlan);
        }
      })();
    </script>
  </body>
</html>`;
}

async function createStripeCheckoutSession(input: {
  env: Env;
  request: Request;
}): Promise<Response> {
  if (!input.env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: "missing_stripe_secret_key" }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await input.request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const planTier = normalizePlanTier(payload.plan_tier);
  if (!planTier) {
    return json({ ok: false, error: "invalid_plan_tier" }, 400);
  }

  const plan = planCatalog(input.env).find((entry) => entry.planTier === planTier);
  if (!plan?.priceEnvValue?.trim()) {
    return json({ ok: false, error: "plan_not_configured", plan_tier: planTier }, 503);
  }

  const origin = new URL(input.request.url).origin;
  const fallbackBase = input.env.THANE_BASE_URL?.trim().replace(/\/$/, "") ?? "https://askthane.com";
  const successUrl =
    asUrlOrNull(payload.success_url) ?? `${fallbackBase}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = asUrlOrNull(payload.cancel_url) ?? `${origin}/subscribe?canceled=1`;
  const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null;
  const organizationId = asSafeIdentifier(payload.organization_id);
  const workspaceId = asSafeIdentifier(payload.workspace_id);

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("line_items[0][price]", plan.priceEnvValue.trim());
  params.set("line_items[0][quantity]", "1");
  params.set("allow_promotion_codes", "true");
  params.set("subscription_data[metadata][plan_tier]", plan.planTier);
  if (organizationId) {
    params.set("subscription_data[metadata][organization_id]", organizationId);
    params.set("metadata[organization_id]", organizationId);
  }
  if (workspaceId) {
    params.set("subscription_data[metadata][workspace_id]", workspaceId);
    params.set("metadata[workspace_id]", workspaceId);
  }
  if (organizationId && workspaceId) {
    params.set("client_reference_id", `${organizationId}:${workspaceId}`);
  }
  if (email) {
    params.set("customer_email", email);
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const result = (await response.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string; type?: string };
  };
  if (!response.ok || !result.url || !result.id) {
    return json(
      {
        ok: false,
        error: "stripe_checkout_session_failed",
        stripe_error: result.error?.message ?? "unknown"
      },
      502
    );
  }

  return json({
    ok: true,
    checkout_url: result.url,
    session_id: result.id,
    plan_tier: plan.planTier
  });
}

async function upsertStripeExternalAccount(input: {
  env: Env;
  organizationId: string;
  externalAccountType: "customer" | "subscription";
  externalAccountId: string;
  displayName?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!input.env.DB) {
    return;
  }
  const nowIso = new Date().toISOString();
  await input.env.DB
    .prepare(
      `INSERT INTO organization_external_accounts (
         id, organization_id, provider, external_account_type, external_account_id, display_name, metadata_json, created_at, updated_at
       ) VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, external_account_type, external_account_id)
       DO UPDATE SET
         organization_id = excluded.organization_id,
         display_name = COALESCE(excluded.display_name, organization_external_accounts.display_name),
         metadata_json = COALESCE(excluded.metadata_json, organization_external_accounts.metadata_json),
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      input.organizationId,
      input.externalAccountType,
      input.externalAccountId,
      input.displayName ?? null,
      JSON.stringify(input.metadata),
      nowIso,
      nowIso
    )
    .run();
}

async function applyStripeEntitlementFromCheckoutSession(input: {
  env: Env;
  session: Record<string, unknown>;
}): Promise<{ linked: boolean; reason?: string }> {
  if (!input.env.DB) {
    return { linked: false, reason: "missing_db_binding" };
  }
  const metadataRaw =
    (input.session.metadata && typeof input.session.metadata === "object" ? input.session.metadata : {}) as Record<
      string,
      unknown
    >;
  const organizationId = asSafeIdentifier(metadataRaw.organization_id);
  const workspaceId = asSafeIdentifier(metadataRaw.workspace_id);
  const planTier = normalizePlanTier(metadataRaw.plan_tier);
  if (!organizationId || !workspaceId || !planTier) {
    return { linked: false, reason: "missing_workspace_or_plan_metadata" };
  }

  const nowIso = new Date().toISOString();
  const customerId = asNonEmptyString(input.session.customer);
  const customerEmail = asNonEmptyString(input.session.customer_email);
  const subscriptionId = asNonEmptyString(input.session.subscription);
  const checkoutSessionId = asNonEmptyString(input.session.id);

  await input.env.DB
    .prepare(
      `UPDATE organizations
       SET plan_tier = ?, billing_email = COALESCE(?, billing_email), updated_at = ?
       WHERE id = ?`
    )
    .bind(planTierForOrganization(planTier), customerEmail ?? null, nowIso, organizationId)
    .run();

  await input.env.DB
    .prepare(
      `UPDATE workspaces
       SET plan_tier = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?`
    )
    .bind(planTierForOrganization(planTier), nowIso, workspaceId, organizationId)
    .run();

  if (customerId) {
    await upsertStripeExternalAccount({
      env: input.env,
      organizationId,
      externalAccountType: "customer",
      externalAccountId: customerId,
      displayName: customerEmail ?? undefined,
      metadata: {
        workspace_id: workspaceId,
        latest_plan_tier: planTier,
        latest_checkout_session_id: checkoutSessionId,
        latest_subscription_id: subscriptionId
      }
    });
  }

  if (subscriptionId) {
    await upsertStripeExternalAccount({
      env: input.env,
      organizationId,
      externalAccountType: "subscription",
      externalAccountId: subscriptionId,
      displayName: customerEmail ?? undefined,
      metadata: {
        workspace_id: workspaceId,
        plan_tier: planTier,
        customer_id: customerId,
        checkout_session_id: checkoutSessionId
      }
    });
  }

  return { linked: true };
}

async function handleStripeWebhook(input: { env: Env; request: Request }): Promise<Response> {
  const rawBody = await input.request.text();
  const signatureHeader = input.request.headers.get("stripe-signature");
  const isValid = await verifyStripeSignatureWithBody({
    rawBody,
    signatureHeader,
    secret: input.env.STRIPE_WEBHOOK_SECRET
  });
  if (!isValid) {
    return json({ error: "invalid_signature" }, 400);
  }

  let event: StripeEventPayload;
  try {
    event = JSON.parse(rawBody) as StripeEventPayload;
  } catch {
    return json({ ok: false, error: "invalid_stripe_event_json" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session =
      (event.data?.object && typeof event.data.object === "object" ? event.data.object : {}) as Record<string, unknown>;
    const entitlement = await applyStripeEntitlementFromCheckoutSession({
      env: input.env,
      session
    });
    return json({ ok: true, received: true, event_type: event.type, entitlement });
  }

  return json({ ok: true, received: true, event_type: event.type ?? "unknown" }, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/checkout/session" && request.method === "OPTIONS") {
      return json({ ok: true }, 204);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "ask-thane-payments" });
    }

    if (url.pathname === "/build-info") {
      return json({
        ok: true,
        service: "ask-thane-payments",
        environment: env.BUILD_ENV ?? "unknown",
        gitSha: env.BUILD_GIT_SHA ?? "unknown",
        deployedAt: env.BUILD_DEPLOYED_AT ?? "unknown"
      });
    }

    if (url.pathname === "/subscribe" && request.method === "GET") {
      return html(renderSubscribePage(env, url), 200);
    }

    if (url.pathname === "/api/checkout/session" && request.method === "POST") {
      return createStripeCheckoutSession({ env, request });
    }

    if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
      return handleStripeWebhook({ env, request });
    }

    return new Response("Not Found", { status: 404 });
  }
};
