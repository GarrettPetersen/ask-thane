interface Env {
  DB?: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  BILLING_LINK_SIGNING_SECRET?: string;
  BILLING_PORTAL_RETURN_URL?: string;
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

interface BillingLinkPayload {
  organizationId: string;
  workspaceId: string;
  exp: number;
  iat?: number;
  planTier?: PlanTier;
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

function planTierForStripePriceId(env: Env, priceId: string | null): PlanTier | null {
  if (!priceId) {
    return null;
  }
  for (const plan of planCatalog(env)) {
    if (plan.priceEnvValue?.trim() && plan.priceEnvValue.trim() === priceId) {
      return plan.planTier;
    }
  }
  return null;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (typeof atob !== "function") {
    return null;
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("btoa_unavailable");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyBillingLinkToken(token: string, secret: string): Promise<BillingLinkPayload | null> {
  const [payloadPart, signaturePart] = token.split(".", 2);
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSignature = await hmacSha256Base64Url(secret, payloadPart);
  if (!timingSafeEqualHex(signaturePart, expectedSignature)) {
    return null;
  }

  const payloadBytes = base64UrlToBytes(payloadPart);
  if (!payloadBytes) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  const organizationId = asSafeIdentifier(payload.organizationId);
  const workspaceId = asSafeIdentifier(payload.workspaceId);
  const exp = typeof payload.exp === "number" && Number.isFinite(payload.exp) ? Math.floor(payload.exp) : 0;
  const planTier = normalizePlanTier(payload.planTier);
  if (!organizationId || !workspaceId || !exp) {
    return null;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp <= nowSeconds) {
    return null;
  }

  const result: BillingLinkPayload = {
    organizationId,
    workspaceId,
    exp
  };
  if (planTier) {
    result.planTier = planTier;
  }
  if (typeof payload.iat === "number" && Number.isFinite(payload.iat)) {
    result.iat = Math.floor(payload.iat);
  }
  return result;
}

async function resolveVerifiedBillingContext(input: {
  env: Env;
  tokenRaw: unknown;
}): Promise<BillingLinkPayload | null> {
  const token = asNonEmptyString(input.tokenRaw);
  const secret = input.env.BILLING_LINK_SIGNING_SECRET?.trim();
  if (!token || !secret) {
    return null;
  }
  return verifyBillingLinkToken(token, secret);
}

function allowedRedirectOrigins(input: { env: Env; requestUrl: URL }): Set<string> {
  const origins = new Set<string>();
  origins.add(input.requestUrl.origin);
  const base = input.env.THANE_BASE_URL?.trim();
  if (base) {
    try {
      origins.add(new URL(base).origin);
    } catch {
      // ignore invalid THANE_BASE_URL
    }
  }
  origins.add("https://askthane.com");
  origins.add("https://payments.askthane.com");
  origins.add("https://payments-staging.askthane.com");
  return origins;
}

function sanitizeRedirectUrl(input: {
  raw: unknown;
  fallback: string;
  allowedOrigins: Set<string>;
}): string {
  const candidate = asUrlOrNull(input.raw);
  if (!candidate) {
    return input.fallback;
  }
  try {
    const parsed = new URL(candidate);
    if (input.allowedOrigins.has(parsed.origin)) {
      return parsed.toString();
    }
  } catch {
    return input.fallback;
  }
  return input.fallback;
}

async function renderSubscribePage(env: Env, requestUrl: URL): Promise<string> {
  const plans = planCatalog(env);
  const verifiedContext = await resolveVerifiedBillingContext({
    env,
    tokenRaw: requestUrl.searchParams.get("billing_token")
  });
  const requestedPlanTier = verifiedContext?.planTier ?? null;
  const autoStart = requestUrl.searchParams.get("autostart") === "1";
  const hasBillingContext = Boolean(verifiedContext);
  const cardsDisabled = hasBillingContext ? "" : " disabled";
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
          <button data-plan="${plan.planTier}"${cardsDisabled}>Start ${plan.label}</button>
        </article>`
    )
    .join("");

  const defaultBase = (env.THANE_BASE_URL?.trim().replace(/\/$/, "") ?? "https://askthane.com").replace(/"/g, "");
  const currentOrigin = requestUrl.origin.replace(/"/g, "");
  const billingToken = asNonEmptyString(requestUrl.searchParams.get("billing_token")) ?? "";
  const contextNotice = hasBillingContext
    ? "Plan changes will apply to this workspace subscription."
    : "Missing or invalid billing link. Open this page from a Thane-generated workspace billing link.";
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
      <p>${contextNotice}</p>
      <div class="grid">${cards}</div>
      <button id="manageSubscriptionButton"${cardsDisabled} style="margin-top:1rem;max-width:360px;">Manage subscription</button>
      <div id="status" class="status" aria-live="polite"></div>
    </main>
    <script>
      (() => {
        const statusEl = document.getElementById("status");
        const manageButton = document.getElementById("manageSubscriptionButton");
        const billingToken = ${JSON.stringify(billingToken)};
        const hasBillingContext = ${JSON.stringify(hasBillingContext)};
        const requestedPlan = ${JSON.stringify(requestedPlanTier)};
        const autoStart = ${JSON.stringify(autoStart)};
        const successUrl = "${defaultBase}/billing/success?session_id={CHECKOUT_SESSION_ID}";
        const cancelUrl = "${currentOrigin}/subscribe?canceled=1";
        const returnUrl = "${currentOrigin}/subscribe";
        const setStatus = (text, isError) => {
          if (!statusEl) return;
          statusEl.textContent = text;
          statusEl.className = isError ? "status error" : "status";
        };
        if (!hasBillingContext) {
          setStatus("Billing link is missing or expired. Please open a new billing link from Thane in Slack.", true);
        }
        const startCheckout = async (plan) => {
          if (!plan || !hasBillingContext) return;
          setStatus("Redirecting to secure checkout...", false);
          try {
            const response = await fetch("/api/checkout/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                plan_tier: plan,
                success_url: successUrl,
                cancel_url: cancelUrl,
                billing_token: billingToken
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

        const startPortal = async () => {
          if (!hasBillingContext) return;
          setStatus("Opening billing portal...", false);
          try {
            const response = await fetch("/api/billing/portal-session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                billing_token: billingToken,
                return_url: returnUrl
              })
            });
            const result = await response.json();
            if (!response.ok || !result.ok || !result.portal_url) {
              throw new Error(result.error || "portal_session_failed");
            }
            window.location.href = result.portal_url;
          } catch (_error) {
            setStatus("Could not open the billing portal right now. Please contact support.", true);
          }
        };

        for (const button of document.querySelectorAll("button[data-plan]")) {
          button.addEventListener("click", async () => {
            const plan = button.getAttribute("data-plan");
            await startCheckout(plan);
          });
        }
        if (manageButton) {
          manageButton.addEventListener("click", async () => {
            await startPortal();
          });
        }

        if (hasBillingContext && autoStart && requestedPlan) {
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

  const billingContext = await resolveVerifiedBillingContext({
    env: input.env,
    tokenRaw: payload.billing_token
  });
  if (!billingContext) {
    return json({ ok: false, error: "invalid_billing_token" }, 401);
  }

  const plan = planCatalog(input.env).find((entry) => entry.planTier === planTier);
  if (!plan?.priceEnvValue?.trim()) {
    return json({ ok: false, error: "plan_not_configured", plan_tier: planTier }, 503);
  }

  const requestUrl = new URL(input.request.url);
  const origin = requestUrl.origin;
  const allowedOrigins = allowedRedirectOrigins({ env: input.env, requestUrl });
  const fallbackBase = input.env.THANE_BASE_URL?.trim().replace(/\/$/, "") ?? "https://askthane.com";
  const successUrl = sanitizeRedirectUrl({
    raw: payload.success_url,
    fallback: `${fallbackBase}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    allowedOrigins
  });
  const cancelUrl = sanitizeRedirectUrl({
    raw: payload.cancel_url,
    fallback: `${origin}/subscribe?canceled=1`,
    allowedOrigins
  });
  const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null;
  const organizationId = billingContext.organizationId;
  const workspaceId = billingContext.workspaceId;

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("line_items[0][price]", plan.priceEnvValue.trim());
  params.set("line_items[0][quantity]", "1");
  params.set("allow_promotion_codes", "true");
  params.set("subscription_data[metadata][plan_tier]", plan.planTier);
  params.set("metadata[plan_tier]", plan.planTier);
  params.set("subscription_data[metadata][organization_id]", organizationId);
  params.set("metadata[organization_id]", organizationId);
  params.set("subscription_data[metadata][workspace_id]", workspaceId);
  params.set("metadata[workspace_id]", workspaceId);
  params.set("client_reference_id", `${organizationId}:${workspaceId}`);
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

async function findStripeExternalAccount(input: {
  env: Env;
  externalAccountType: "customer" | "subscription";
  externalAccountId: string;
}): Promise<{ organizationId: string; workspaceId?: string } | null> {
  if (!input.env.DB) {
    return null;
  }
  const row = await input.env.DB
    .prepare(
      `SELECT organization_id, metadata_json
       FROM organization_external_accounts
       WHERE provider = 'stripe'
         AND external_account_type = ?
         AND external_account_id = ?
       LIMIT 1`
    )
    .bind(input.externalAccountType, input.externalAccountId)
    .first<Record<string, unknown>>();
  const organizationId = asSafeIdentifier(row?.organization_id);
  if (!organizationId) {
    return null;
  }
  let workspaceId: string | undefined;
  if (typeof row?.metadata_json === "string") {
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const parsedWorkspaceId = asSafeIdentifier(metadata.workspace_id);
      if (parsedWorkspaceId) {
        workspaceId = parsedWorkspaceId;
      }
    } catch {
      // ignore metadata parse failure
    }
  }
  return workspaceId ? { organizationId, workspaceId } : { organizationId };
}

async function findStripeCustomerId(input: {
  env: Env;
  organizationId: string;
  workspaceId: string;
}): Promise<string | null> {
  if (!input.env.DB) {
    return null;
  }
  const rows = await input.env.DB
    .prepare(
      `SELECT external_account_id, metadata_json
       FROM organization_external_accounts
       WHERE provider = 'stripe'
         AND organization_id = ?
         AND external_account_type = 'customer'
       ORDER BY updated_at DESC
       LIMIT 20`
    )
    .bind(input.organizationId)
    .all<Record<string, unknown>>();

  for (const row of rows.results ?? []) {
    const externalAccountId = asNonEmptyString(row.external_account_id);
    if (!externalAccountId) {
      continue;
    }
    if (typeof row.metadata_json !== "string") {
      return externalAccountId;
    }
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const workspaceId = asSafeIdentifier(metadata.workspace_id);
      if (!workspaceId || workspaceId === input.workspaceId) {
        return externalAccountId;
      }
    } catch {
      return externalAccountId;
    }
  }
  return null;
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
  const metadataOrganizationId = asSafeIdentifier(metadataRaw.organization_id);
  const metadataWorkspaceId = asSafeIdentifier(metadataRaw.workspace_id);
  const planTier = normalizePlanTier(metadataRaw.plan_tier);

  const nowIso = new Date().toISOString();
  const customerId = asNonEmptyString(input.session.customer);
  const customerEmail = asNonEmptyString(input.session.customer_email);
  const subscriptionId = asNonEmptyString(input.session.subscription);
  const checkoutSessionId = asNonEmptyString(input.session.id);
  let organizationId = metadataOrganizationId;
  let workspaceId = metadataWorkspaceId;

  if ((!organizationId || !workspaceId) && customerId) {
    const linkedFromCustomer = await findStripeExternalAccount({
      env: input.env,
      externalAccountType: "customer",
      externalAccountId: customerId
    });
    if (linkedFromCustomer?.organizationId) {
      organizationId = linkedFromCustomer.organizationId;
      workspaceId = workspaceId ?? linkedFromCustomer.workspaceId ?? null;
    }
  }

  if ((!organizationId || !workspaceId) && subscriptionId) {
    const linkedFromSubscription = await findStripeExternalAccount({
      env: input.env,
      externalAccountType: "subscription",
      externalAccountId: subscriptionId
    });
    if (linkedFromSubscription?.organizationId) {
      organizationId = organizationId ?? linkedFromSubscription.organizationId;
      workspaceId = workspaceId ?? linkedFromSubscription.workspaceId ?? null;
    }
  }

  if (!organizationId || !workspaceId || !planTier) {
    return { linked: false, reason: "missing_workspace_or_plan_metadata" };
  }

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
      ...(customerEmail ? { displayName: customerEmail } : {}),
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
      ...(customerEmail ? { displayName: customerEmail } : {}),
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

async function updateWorkspacePlanTier(input: {
  env: Env;
  organizationId: string;
  workspaceId: string;
  planTier: string;
}): Promise<void> {
  if (!input.env.DB) {
    return;
  }
  const nowIso = new Date().toISOString();
  await input.env.DB
    .prepare(
      `UPDATE organizations
       SET plan_tier = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(input.planTier, nowIso, input.organizationId)
    .run();
  await input.env.DB
    .prepare(
      `UPDATE workspaces
       SET plan_tier = ?, updated_at = ?
       WHERE organization_id = ?
         AND id = ?`
    )
    .bind(input.planTier, nowIso, input.organizationId, input.workspaceId)
    .run();
}

async function applyStripeSubscriptionLifecycleEvent(input: {
  env: Env;
  subscription: Record<string, unknown>;
  deleted: boolean;
}): Promise<{ linked: boolean; reason?: string }> {
  if (!input.env.DB) {
    return { linked: false, reason: "missing_db_binding" };
  }
  const subscriptionId = asNonEmptyString(input.subscription.id);
  const customerId = asNonEmptyString(input.subscription.customer);
  const status = asNonEmptyString(input.subscription.status);
  const cancelAtPeriodEnd = Boolean(input.subscription.cancel_at_period_end);
  const items = (input.subscription.items && typeof input.subscription.items === "object"
    ? (input.subscription.items as { data?: Array<Record<string, unknown>> }).data
    : []) ?? [];
  const firstItem = items.length > 0 ? items[0] : undefined;
  const firstPrice = firstItem && typeof firstItem.price === "object" ? (firstItem.price as Record<string, unknown>) : null;
  const priceId = firstPrice ? asNonEmptyString(firstPrice.id) : null;
  const planTier = planTierForStripePriceId(input.env, priceId);

  let linked = subscriptionId
    ? await findStripeExternalAccount({
        env: input.env,
        externalAccountType: "subscription",
        externalAccountId: subscriptionId
      })
    : null;
  if (!linked && customerId) {
    linked = await findStripeExternalAccount({
      env: input.env,
      externalAccountType: "customer",
      externalAccountId: customerId
    });
  }
  if (!linked?.organizationId || !linked.workspaceId) {
    return { linked: false, reason: "missing_linked_workspace" };
  }

  if (input.deleted || status === "canceled") {
    await updateWorkspacePlanTier({
      env: input.env,
      organizationId: linked.organizationId,
      workspaceId: linked.workspaceId,
      planTier: "free"
    });
    return { linked: true };
  }

  if (cancelAtPeriodEnd && status === "active") {
    // Preserve current entitlement until the period actually ends.
    return { linked: true };
  }

  if (!planTier) {
    return { linked: false, reason: "unknown_subscription_plan_price" };
  }

  await updateWorkspacePlanTier({
    env: input.env,
    organizationId: linked.organizationId,
    workspaceId: linked.workspaceId,
    planTier: planTierForOrganization(planTier)
  });
  return { linked: true };
}

async function createBillingPortalSession(input: { env: Env; request: Request }): Promise<Response> {
  if (!input.env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: "missing_stripe_secret_key" }, 500);
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await input.request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const billingContext = await resolveVerifiedBillingContext({
    env: input.env,
    tokenRaw: payload.billing_token
  });
  if (!billingContext) {
    return json({ ok: false, error: "invalid_billing_token" }, 401);
  }
  const customerId = await findStripeCustomerId({
    env: input.env,
    organizationId: billingContext.organizationId,
    workspaceId: billingContext.workspaceId
  });
  if (!customerId) {
    return json({ ok: false, error: "stripe_customer_not_found" }, 404);
  }

  const requestUrl = new URL(input.request.url);
  const allowedOrigins = allowedRedirectOrigins({ env: input.env, requestUrl });
  const returnUrl = sanitizeRedirectUrl({
    raw: payload.return_url,
    fallback:
      input.env.BILLING_PORTAL_RETURN_URL?.trim() ??
      `${requestUrl.origin}/subscribe?billing_updated=1`,
    allowedOrigins
  });

  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("return_url", returnUrl);
  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const result = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !result.url || !result.id) {
    return json(
      {
        ok: false,
        error: "stripe_portal_session_failed",
        stripe_error: result.error?.message ?? "unknown"
      },
      502
    );
  }
  return json({ ok: true, portal_url: result.url, session_id: result.id });
}

async function handleStripeWebhook(input: { env: Env; request: Request }): Promise<Response> {
  const rawBody = await input.request.text();
  const signatureHeader = input.request.headers.get("stripe-signature");
  const isValid = await verifyStripeSignatureWithBody(
    input.env.STRIPE_WEBHOOK_SECRET
      ? {
          rawBody,
          signatureHeader,
          secret: input.env.STRIPE_WEBHOOK_SECRET
        }
      : {
          rawBody,
          signatureHeader
        }
  );
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

  if (event.type === "customer.subscription.updated") {
    const subscription =
      (event.data?.object && typeof event.data.object === "object" ? event.data.object : {}) as Record<string, unknown>;
    const entitlement = await applyStripeSubscriptionLifecycleEvent({
      env: input.env,
      subscription,
      deleted: false
    });
    return json({ ok: true, received: true, event_type: event.type, entitlement });
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription =
      (event.data?.object && typeof event.data.object === "object" ? event.data.object : {}) as Record<string, unknown>;
    const entitlement = await applyStripeSubscriptionLifecycleEvent({
      env: input.env,
      subscription,
      deleted: true
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

    if (url.pathname === "/api/billing/portal-session" && request.method === "OPTIONS") {
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
      return html(await renderSubscribePage(env, url), 200);
    }

    if (url.pathname === "/api/checkout/session" && request.method === "POST") {
      return createStripeCheckoutSession({ env, request });
    }

    if (url.pathname === "/api/billing/portal-session" && request.method === "POST") {
      return createBillingPortalSession({ env, request });
    }

    if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
      return handleStripeWebhook({ env, request });
    }

    return new Response("Not Found", { status: 404 });
  }
};
