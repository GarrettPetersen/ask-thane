import type { BotEnv } from "./task-inference";

const BILLING_TOKEN_TTL_SECONDS = 15 * 60;

export type BillingPlanTier = "team" | "growth" | "scale" | "scale_plus";

interface BillingLinkPayload {
  organizationId: string;
  workspaceId: string;
  exp: number;
  iat: number;
  planTier?: BillingPlanTier;
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

async function signPayload(secret: string, payload: BillingLinkPayload): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = bytesToBase64Url(new TextEncoder().encode(payloadJson));
  const signatureEncoded = await hmacSha256Base64Url(secret, payloadEncoded);
  return `${payloadEncoded}.${signatureEncoded}`;
}

function resolveSubscriptionPageUrl(env: BotEnv): string {
  const configured = env.SUBSCRIPTION_PAGE_URL?.trim();
  if (configured) {
    return configured;
  }
  return "https://payments.askthane.com/subscribe";
}

export async function createSignedBillingSubscribeUrl(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  selectedTier?: BillingPlanTier;
}): Promise<string> {
  const base = resolveSubscriptionPageUrl(input.env);
  const secret = input.env.BILLING_LINK_SIGNING_SECRET?.trim();
  const url = new URL(base);
  if (!secret) {
    return url.toString();
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: BillingLinkPayload = {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    iat: nowSeconds,
    exp: nowSeconds + BILLING_TOKEN_TTL_SECONDS
  };
  if (input.selectedTier) {
    payload.planTier = input.selectedTier;
  }

  const token = await signPayload(secret, payload);
  url.searchParams.set("billing_token", token);
  if (input.selectedTier) {
    url.searchParams.set("autostart", "1");
  }
  return url.toString();
}
