import type { BotEnv } from "./task-inference";

function parseHmacKeyMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const segment of (raw ?? "").split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const [keyId, secret] = trimmed.split(":");
    if (!keyId || !secret) {
      continue;
    }
    map.set(keyId.trim(), secret.trim());
  }
  return map;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function isAdminAuthorized(request: Request, env: BotEnv): Promise<boolean> {
  const requiredToken = env.ADMIN_TRIGGER_TOKEN?.trim();
  const authHeader = request.headers.get("authorization") ?? "";
  if (requiredToken && authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice("Bearer ".length).trim();
    if (bearer && bearer === requiredToken) {
      return true;
    }
  }

  const headerToken = request.headers.get("x-admin-token")?.trim();
  if (requiredToken && headerToken && headerToken === requiredToken) {
    return true;
  }

  const keyMap = parseHmacKeyMap(env.ADMIN_HMAC_KEYS);
  if (keyMap.size === 0) {
    return false;
  }

  const keyId = request.headers.get("x-admin-key-id")?.trim() ?? "";
  const timestamp = request.headers.get("x-admin-timestamp")?.trim() ?? "";
  const signature = request.headers.get("x-admin-signature")?.trim() ?? "";
  if (!keyId || !timestamp || !signature) {
    return false;
  }

  const secret = keyMap.get(keyId);
  if (!secret) {
    return false;
  }

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) {
    return false;
  }
  const nowMs = Date.now();
  const skewSec = Number(env.ADMIN_HMAC_MAX_SKEW_SECONDS ?? "300");
  const maxSkewMs = (Number.isFinite(skewSec) ? Math.max(30, Math.floor(skewSec)) : 300) * 1000;
  if (Math.abs(nowMs - tsMs) > maxSkewMs) {
    return false;
  }

  const url = new URL(request.url);
  const payload = [request.method.toUpperCase(), url.pathname, timestamp].join("\n");
  const expected = await sign(payload, secret);
  return timingSafeEqual(signature, expected);
}
