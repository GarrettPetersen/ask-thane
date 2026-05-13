const MAX_SLACK_REQUEST_AGE_SECONDS = 60 * 5;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return diff === 0;
}

async function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const baseString = `v0:${timestamp}:${rawBody}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  return `v0=${toHex(new Uint8Array(signature))}`;
}

export async function verifySlackRequestSignature(input: {
  signingSecret?: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!input.signingSecret) {
    return { ok: false, reason: "missing_signing_secret" };
  }

  if (!input.timestampHeader || !input.signatureHeader) {
    return { ok: false, reason: "missing_signature_headers" };
  }

  const timestampSeconds = Number(input.timestampHeader);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - timestampSeconds);
  if (ageSeconds > MAX_SLACK_REQUEST_AGE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expectedSignature = await computeSlackSignature(
    input.signingSecret,
    input.timestampHeader,
    input.rawBody
  );

  if (!constantTimeEqual(expectedSignature, input.signatureHeader)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}
