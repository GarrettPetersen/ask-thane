#!/usr/bin/env node

const enabled = process.env.BILLING_E2E_ENABLED === "true";
if (!enabled) {
  console.error("BILLING_E2E_ENABLED is not true; refusing to run live billing E2E.");
  process.exit(1);
}

const baseUrl = (process.env.BILLING_E2E_BASE_URL ?? "https://payments-staging.askthane.com").trim();
const stripeSecret = (process.env.BILLING_E2E_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? "").trim();
const stripeWebhookSecret = (process.env.BILLING_E2E_STRIPE_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
const planTier = (process.env.BILLING_E2E_PLAN_TIER ?? "team").trim();
const email = (process.env.BILLING_E2E_EMAIL ?? `billing-e2e+${Date.now()}@askthane.com`).trim();

if (!stripeSecret) {
  console.error("Missing BILLING_E2E_STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY fallback).");
  process.exit(1);
}

function assertUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("base URL must be https");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid BILLING_E2E_BASE_URL: ${url} (${error instanceof Error ? error.message : "unknown"})`);
  }
}

function asJsonOrThrow(response, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 400)}`);
  }
}

async function stripeRequest(pathname, init = {}) {
  const response = await fetch(`https://api.stripe.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  const json = asJsonOrThrow(response, text);
  if (!response.ok) {
    throw new Error(`Stripe API error ${response.status} ${pathname}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function signStripePayload(secret, payload, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const body = `${timestamp}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

async function main() {
  const origin = assertUrl(baseUrl).origin;
  const successUrl = `${origin}/billing/e2e-success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/billing/e2e-cancel`;

  const checkoutRes = await fetch(`${origin}/api/checkout/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      plan_tier: planTier,
      email,
      success_url: successUrl,
      cancel_url: cancelUrl
    })
  });
  const checkoutText = await checkoutRes.text();
  const checkoutJson = asJsonOrThrow(checkoutRes, checkoutText);
  if (!checkoutRes.ok || !checkoutJson.ok || typeof checkoutJson.session_id !== "string") {
    throw new Error(`Checkout endpoint failed: ${JSON.stringify(checkoutJson)}`);
  }

  const sessionId = checkoutJson.session_id;
  const session = await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.mode !== "subscription") {
    throw new Error(`Expected subscription mode, got: ${session.mode}`);
  }

  const expired = await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }
  });
  if (expired.status !== "expired") {
    throw new Error(`Expected expired status after expire call, got: ${expired.status}`);
  }

  let webhookStatus = "skipped";
  if (stripeWebhookSecret) {
    const eventPayload = JSON.stringify({
      id: `evt_thane_e2e_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: sessionId, object: "checkout.session" } }
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signStripePayload(stripeWebhookSecret, eventPayload, timestamp);
    const webhookRes = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature
      },
      body: eventPayload
    });
    if (!webhookRes.ok) {
      const webhookText = await webhookRes.text();
      throw new Error(`Webhook endpoint failed (${webhookRes.status}): ${webhookText.slice(0, 400)}`);
    }
    webhookStatus = "passed";
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        base_url: origin,
        plan_tier: planTier,
        session_id: sessionId,
        mode: session.mode,
        checkout_status_before_expire: session.status,
        checkout_status_after_expire: expired.status,
        webhook_signature_path: webhookStatus
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
