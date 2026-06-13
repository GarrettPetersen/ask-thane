import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function signStripeWebhookPayload(input: { secret: string; payload: string; timestamp: number }): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const toSign = `${input.timestamp}.${input.payload}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${input.timestamp},v1=${hex}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signBillingToken(input: {
  secret: string;
  organizationId: string;
  workspaceId: string;
  expiresInSeconds?: number;
  planTier?: "cli_team" | "team" | "growth" | "scale" | "scale_plus";
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    exp: now + (input.expiresInSeconds ?? 900),
    iat: now,
    ...(input.planTier ? { planTier: input.planTier } : {})
  };
  const payloadEncoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadEncoded));
  const signatureEncoded = bytesToBase64Url(new Uint8Array(signature));
  return `${payloadEncoded}.${signatureEncoded}`;
}

describe("@ask-thane/payments-worker", () => {
  it("serves health", async () => {
    const res = await worker.fetch(new Request("https://pay.local/health"), {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "ask-thane-payments"
    });
  });

  it("serves build info", async () => {
    const res = await worker.fetch(new Request("https://pay.local/build-info"), {
      BUILD_ENV: "staging",
      BUILD_GIT_SHA: "abc123",
      BUILD_DEPLOYED_AT: "2026-05-14T20:00:00.000Z"
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "ask-thane-payments",
      environment: "staging",
      gitSha: "abc123",
      deployedAt: "2026-05-14T20:00:00.000Z"
    });
  });

  it("accepts Stripe webhook when signature is valid", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = "whsec_test_123";
    const signature = await signStripeWebhookPayload({ secret, payload, timestamp });
    const res = await worker.fetch(
      new Request("https://pay.local/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature
        }
      }),
      { STRIPE_WEBHOOK_SECRET: secret }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      received: true,
      event_type: "checkout.session.completed"
    });
  });

  it("rejects Stripe webhook when signature is invalid", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const res = await worker.fetch(
      new Request("https://pay.local/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=deadbeef"
        }
      }),
      { STRIPE_WEBHOOK_SECRET: "whsec_test_123" }
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_signature" });
  });

  it("rejects Stripe webhook when signature timestamp is stale", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const timestamp = Math.floor(Date.now() / 1000) - 1000;
    const secret = "whsec_test_123";
    const signature = await signStripeWebhookPayload({ secret, payload, timestamp });
    const res = await worker.fetch(
      new Request("https://pay.local/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature
        }
      }),
      { STRIPE_WEBHOOK_SECRET: secret }
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_signature" });
  });

  it("serves subscribe page", async () => {
    const billingToken = await signBillingToken({
      secret: "billing_secret",
      organizationId: "org_1",
      workspaceId: "ws_1",
      planTier: "team"
    });
    const res = await worker.fetch(new Request(`https://pay.local/subscribe?billing_token=${billingToken}`), {
      BILLING_LINK_SIGNING_SECRET: "billing_secret"
    });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("Choose a Thane plan");
  });

  it("returns config error when checkout is not wired", async () => {
    const res = await worker.fetch(
      new Request("https://pay.local/api/checkout/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_tier: "team" })
      }),
      {}
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "missing_stripe_secret_key"
    });
  });

  it("creates checkout session via Stripe API", async () => {
    const billingToken = await signBillingToken({
      secret: "billing_secret",
      organizationId: "org_test",
      workspaceId: "ws_test"
    });
    const originalFetch = globalThis.fetch;
    let stripeBody = "";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        if (input instanceof Request) {
          stripeBody = await input.text();
        } else if (init?.body instanceof URLSearchParams) {
          stripeBody = init.body.toString();
        } else if (typeof init?.body === "string") {
          stripeBody = init.body;
        }
        return new Response(
          JSON.stringify({
            id: "cs_test_123",
            url: "https://checkout.stripe.com/pay/cs_test_123"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected_fetch:${url}`);
    };
    try {
      const res = await worker.fetch(
        new Request("https://pay.local/api/checkout/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            plan_tier: "team",
            email: "owner@example.com",
            billing_token: billingToken
          })
        }),
        {
          STRIPE_SECRET_KEY: "sk_test_123",
          BILLING_LINK_SIGNING_SECRET: "billing_secret",
          STRIPE_PRICE_TEAM_MONTHLY: "price_team_123",
          THANE_BASE_URL: "https://askthane.com"
        }
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        checkout_url: "https://checkout.stripe.com/pay/cs_test_123",
        session_id: "cs_test_123",
        plan_tier: "team"
      });
      expect(stripeBody).toContain("subscription_data%5Bmetadata%5D%5Borganization_id%5D=org_test");
      expect(stripeBody).toContain("subscription_data%5Bmetadata%5D%5Bworkspace_id%5D=ws_test");
      expect(stripeBody).toContain("metadata%5Borganization_id%5D=org_test");
      expect(stripeBody).toContain("metadata%5Bworkspace_id%5D=ws_test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates checkout session for Thane CLI Team", async () => {
    const billingToken = await signBillingToken({
      secret: "billing_secret",
      organizationId: "org_cli",
      workspaceId: "ws_cli",
      planTier: "cli_team"
    });
    const originalFetch = globalThis.fetch;
    let stripeBody = "";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        stripeBody = init?.body instanceof URLSearchParams ? init.body.toString() : "";
        return new Response(
          JSON.stringify({
            id: "cs_cli_123",
            url: "https://checkout.stripe.com/pay/cs_cli_123"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected_fetch:${url}`);
    };
    try {
      const res = await worker.fetch(
        new Request("https://pay.local/api/checkout/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            plan_tier: "cli_team",
            billing_token: billingToken
          })
        }),
        {
          STRIPE_SECRET_KEY: "sk_test_123",
          BILLING_LINK_SIGNING_SECRET: "billing_secret",
          STRIPE_PRICE_CLI_TEAM_MONTHLY: "price_cli_team_123",
          THANE_BASE_URL: "https://askthane.com"
        }
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        checkout_url: "https://checkout.stripe.com/pay/cs_cli_123",
        plan_tier: "cli_team"
      });
      expect(stripeBody).toContain("line_items%5B0%5D%5Bprice%5D=price_cli_team_123");
      expect(stripeBody).toContain("metadata%5Bplan_tier%5D=cli_team");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("links entitlement on checkout.session.completed webhook", async () => {
    const operations: Array<{ sql: string; bind: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                operations.push({ sql, bind: args });
                return {};
              }
            };
          }
        };
      }
    };

    const payload = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          customer: "cus_1",
          customer_email: "owner@example.com",
          subscription: "sub_1",
          metadata: {
            organization_id: "org_1",
            workspace_id: "ws_1",
            plan_tier: "growth"
          }
        }
      }
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = "whsec_test_123";
    const signature = await signStripeWebhookPayload({ secret, payload, timestamp });
    const res = await worker.fetch(
      new Request("https://pay.local/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature
        }
      }),
      {
        STRIPE_WEBHOOK_SECRET: secret,
        DB: db as unknown as D1Database
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      received: true,
      event_type: "checkout.session.completed",
      entitlement: { linked: true }
    });
    expect(operations.some((op) => op.sql.includes("UPDATE organizations"))).toBe(true);
    expect(operations.some((op) => op.sql.includes("UPDATE workspaces"))).toBe(true);
    expect(operations.some((op) => op.sql.includes("INSERT INTO organization_external_accounts"))).toBe(true);
  });

  it("rejects checkout when billing token is invalid", async () => {
    const res = await worker.fetch(
      new Request("https://pay.local/api/checkout/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_tier: "team", billing_token: "bad.token" })
      }),
      {
        STRIPE_SECRET_KEY: "sk_test_123",
        BILLING_LINK_SIGNING_SECRET: "billing_secret",
        STRIPE_PRICE_TEAM_MONTHLY: "price_team_123"
      }
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_billing_token"
    });
  });

  it("creates Stripe billing portal session", async () => {
    const billingToken = await signBillingToken({
      secret: "billing_secret",
      organizationId: "org_1",
      workspaceId: "ws_1"
    });
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              all: async () => {
                if (sql.includes("external_account_type = 'customer'") && args[0] === "org_1") {
                  return {
                    results: [
                      {
                        external_account_id: "cus_123",
                        metadata_json: JSON.stringify({ workspace_id: "ws_1" })
                      }
                    ]
                  };
                }
                return { results: [] };
              }
            };
          }
        };
      }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/billing_portal/sessions")) {
        return new Response(JSON.stringify({ id: "bps_123", url: "https://billing.stripe.com/p/session_123" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected_fetch:${url}`);
    };

    try {
      const res = await worker.fetch(
        new Request("https://pay.local/api/billing/portal-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ billing_token: billingToken, return_url: "https://askthane.com/billing/manage" })
        }),
        {
          STRIPE_SECRET_KEY: "sk_test_123",
          BILLING_LINK_SIGNING_SECRET: "billing_secret",
          DB: db as unknown as D1Database
        }
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        portal_url: "https://billing.stripe.com/p/session_123",
        session_id: "bps_123"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies period-end lifecycle semantics for subscription webhooks", async () => {
    const operations: Array<{ sql: string; bind: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("external_account_type = ?") && args[0] === "subscription" && args[1] === "sub_1") {
                  return {
                    organization_id: "org_1",
                    metadata_json: JSON.stringify({ workspace_id: "ws_1" })
                  };
                }
                return null;
              },
              run: async () => {
                operations.push({ sql, bind: args });
                return {};
              }
            };
          }
        };
      }
    };

    const secret = "whsec_test_123";
    const updatedPayload = JSON.stringify({
      id: "evt_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          cancel_at_period_end: true,
          items: { data: [{ price: { id: "price_team_123" } }] }
        }
      }
    });
    const updatedSig = await signStripeWebhookPayload({
      secret,
      payload: updatedPayload,
      timestamp: Math.floor(Date.now() / 1000)
    });
    const updatedRes = await worker.fetch(
      new Request("https://pay.local/webhooks/stripe", {
        method: "POST",
        body: updatedPayload,
        headers: { "content-type": "application/json", "stripe-signature": updatedSig }
      }),
      { STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_TEAM_MONTHLY: "price_team_123", DB: db as unknown as D1Database }
    );
    expect(updatedRes.status).toBe(200);
    expect(operations.some((op) => op.sql.includes("UPDATE workspaces"))).toBe(false);

    const deletedPayload = JSON.stringify({
      id: "evt_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "canceled",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_team_123" } }] }
        }
      }
    });
    const deletedSig = await signStripeWebhookPayload({
      secret,
      payload: deletedPayload,
      timestamp: Math.floor(Date.now() / 1000)
    });
    const deletedRes = await worker.fetch(
      new Request("https://pay.local/webhooks/stripe", {
        method: "POST",
        body: deletedPayload,
        headers: { "content-type": "application/json", "stripe-signature": deletedSig }
      }),
      { STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_TEAM_MONTHLY: "price_team_123", DB: db as unknown as D1Database }
    );
    expect(deletedRes.status).toBe(200);
    expect(operations.some((op) => op.sql.includes("UPDATE workspaces"))).toBe(true);
  });

  it("returns 404 for unknown route", async () => {
    const res = await worker.fetch(new Request("https://pay.local/nope"), {});
    expect(res.status).toBe(404);
  });
});
