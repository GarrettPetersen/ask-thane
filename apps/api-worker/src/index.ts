import { D1TaskRepository } from "@ask-thane/data";

interface Env {
  DB: D1Database;
  INTERNAL_API_BEARER_TOKEN?: string;
  RESEND_API_KEY?: string;
  THANE_CLI_AUTH_DEV_CODES?: string;
  THANE_CLI_AUTH_SECRET?: string;
  THANE_CLI_EMAIL_FROM?: string;
  THANE_CLI_INVITE_BASE_URL?: string;
  BUILD_ENV?: string;
  BUILD_GIT_SHA?: string;
  BUILD_DEPLOYED_AT?: string;
}

interface AuthStartPayload {
  email?: unknown;
  displayName?: unknown;
}

interface AuthVerifyPayload {
  email?: unknown;
  code?: unknown;
}

interface MfaVerifyPayload {
  challengeToken?: unknown;
  code?: unknown;
}

interface MfaSetupVerifyPayload {
  factorId?: unknown;
  code?: unknown;
}

interface MfaDisablePayload {
  code?: unknown;
}

interface WorkspaceInviteCreatePayload {
  workspaceId?: unknown;
  workspaceSlug?: unknown;
  workspaceName?: unknown;
  role?: unknown;
  expiresInHours?: unknown;
  maxUses?: unknown;
}

interface WorkspaceInviteAcceptPayload {
  token?: unknown;
}

interface TokenPayload {
  email: string;
  exp: number;
  purpose: "auth" | "mfa_challenge";
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email.slice(0, 320);
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const displayName = value.trim();
  return displayName ? displayName.slice(0, 120) : null;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim();
  return /^\d{6}$/.test(code) ? code : null;
}

function normalizeWorkspaceSlug(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? slug.slice(0, 80) : null;
}

function normalizeWorkspaceRole(value: unknown): "admin" | "member" {
  return value === "admin" ? "admin" : "member";
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function makeVerificationCode(): string {
  const randomValues = new Uint32Array(1);
  crypto.getRandomValues(randomValues);
  return String((randomValues[0] ?? 0) % 1_000_000).padStart(6, "0");
}

function makeTotpSecret(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");
}

function makeInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function base64UrlEncode(value: string | ArrayBuffer | Uint8Array): string {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function hmacSha256(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

function authSecret(env: Env): string {
  const configured = env.THANE_CLI_AUTH_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (env.BUILD_ENV === "production") {
    throw new Error("THANE_CLI_AUTH_SECRET is required in production.");
  }
  return "thane-cli-local-dev-auth-secret";
}

async function hashAuthCode(env: Env, email: string, code: string): Promise<string> {
  return sha256Hex(`${authSecret(env)}:${email}:${code}`);
}

async function signToken(env: Env, payload: TokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(await hmacSha256(encodedPayload, authSecret(env)));
  return `${encodedPayload}.${signature}`;
}

async function verifyToken(env: Env, token: unknown, purpose: TokenPayload["purpose"]): Promise<TokenPayload | null> {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }
  const expected = base64UrlEncode(await hmacSha256(encodedPayload, authSecret(env)));
  if (signature !== expected) {
    return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as TokenPayload;
    if (payload.purpose !== purpose || payload.exp < Math.floor(Date.now() / 1000) || !normalizeEmail(payload.email)) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

async function accountIdForEmail(email: string): Promise<string> {
  return `acct_${(await sha256Hex(`thane_cli:${email}`)).slice(0, 24)}`;
}

async function buildAccount(env: Env, input: { email: string; displayName?: string | null }): Promise<Record<string, string>> {
  const displayName = input.displayName?.trim() || input.email.split("@")[0] || input.email;
  return {
    id: await accountIdForEmail(input.email),
    email: input.email,
    displayName,
    createdAt: nowIso(),
    authToken: await signToken(env, {
      email: input.email,
      purpose: "auth",
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    })
  };
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authSecret(env)));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env: Env, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(secret)
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

async function decryptSecret(env: Env, ciphertext: string): Promise<string> {
  const [ivRaw, valueRaw] = ciphertext.split(".");
  if (!ivRaw || !valueRaw) {
    throw new Error("Invalid encrypted secret.");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecode(ivRaw)) },
    await encryptionKey(env),
    toArrayBuffer(base64UrlDecode(valueRaw))
  );
  return new TextDecoder().decode(plaintext);
}

function decodeBase32(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of input.replaceAll("=", "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) {
      continue;
    }
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Uint8Array.from(bytes);
}

async function totp(secret: string, timeStep: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(decodeBase32(secret)), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  view.setUint32(4, timeStep);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function verifyTotp(secret: string, code: string): Promise<boolean> {
  const currentStep = Math.floor(Date.now() / 30_000);
  const candidates = [currentStep - 1, currentStep, currentStep + 1];
  for (const step of candidates) {
    if ((await totp(secret, step)) === code) {
      return true;
    }
  }
  return false;
}

async function activeMfaFactor(env: Env, email: string): Promise<{ id: string; secret_ciphertext: string } | null> {
  const row = await env.DB
    .prepare(
      `SELECT id, secret_ciphertext
       FROM thane_cli_mfa_factors
       WHERE email = ? AND factor_type = 'totp' AND enabled_at IS NOT NULL AND disabled_at IS NULL
       ORDER BY enabled_at DESC
       LIMIT 1`
    )
    .bind(email)
    .first<{ id?: string; secret_ciphertext?: string }>();
  return row?.id && row.secret_ciphertext ? { id: row.id, secret_ciphertext: row.secret_ciphertext } : null;
}

async function requireAuthEmail(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const payload = await verifyToken(env, authHeader.slice("bearer ".length).trim(), "auth");
  return payload?.email ?? null;
}

function inviteBaseUrl(env: Env, request: Request): string {
  const configured = env.THANE_CLI_INVITE_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/g, "");
  }
  const url = new URL(request.url);
  return `${url.origin}/invite`;
}

function extractInviteToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const token = url.pathname.split("/").filter(Boolean).at(-1);
    return token || null;
  } catch (_error) {
    return trimmed;
  }
}

async function hashInviteToken(token: string): Promise<string> {
  return sha256Hex(`thane_cli_invite:${token}`);
}

async function inviteByToken(env: Env, token: string): Promise<{
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  role: "admin" | "member";
  expires_at: string;
  revoked_at?: string | null;
  accepted_count?: number | null;
  max_uses?: number | null;
} | null> {
  return env.DB
    .prepare(
      `SELECT id, workspace_id, workspace_slug, workspace_name, role, expires_at, revoked_at, accepted_count, max_uses
       FROM thane_cli_workspace_invites
       WHERE token_hash = ?
       LIMIT 1`
    )
    .bind(await hashInviteToken(token))
    .first<{
      id: string;
      workspace_id: string;
      workspace_slug: string;
      workspace_name: string;
      role: "admin" | "member";
      expires_at: string;
      revoked_at?: string | null;
      accepted_count?: number | null;
      max_uses?: number | null;
    }>();
}

function validateInvite(row: Awaited<ReturnType<typeof inviteByToken>>): Response | null {
  if (!row) {
    return Response.json({ ok: false, error: "invite_not_found" }, { status: 404 });
  }
  if (row.revoked_at) {
    return Response.json({ ok: false, error: "invite_revoked" }, { status: 410 });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return Response.json({ ok: false, error: "invite_expired" }, { status: 410 });
  }
  if (row.max_uses && Number(row.accepted_count ?? 0) >= row.max_uses) {
    return Response.json({ ok: false, error: "invite_used_up" }, { status: 410 });
  }
  return null;
}

function renderInviteWorkspace(row: NonNullable<Awaited<ReturnType<typeof inviteByToken>>>): Record<string, unknown> {
  return {
    id: row.workspace_id,
    slug: row.workspace_slug,
    name: row.workspace_name,
    role: row.role,
    expiresAt: row.expires_at
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inviteErrorHtml(title: string, message: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} | Thane Chat</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f5f2; color: #24211c; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 32px; box-sizing: border-box; }
    section { max-width: 560px; width: 100%; background: #fff; border: 1px solid #ded9cf; border-radius: 8px; padding: 28px; box-shadow: 0 18px 50px rgba(30, 28, 24, 0.08); }
    h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.1; }
    p { margin: 0; color: #6b6258; line-height: 1.55; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </section>
  </main>
</body>
</html>`,
    { status: 410, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function handleThaneCliWorkspaceInviteLanding(token: string, env: Env, request: Request): Promise<Response> {
  const row = await inviteByToken(env, token);
  const invalid = validateInvite(row);
  if (invalid) {
    const status = invalid.status;
    const payload = (await invalid.json()) as { error?: string };
    const messages: Record<string, string> = {
      invite_not_found: "This invite link could not be found. Ask the workspace admin for a fresh link.",
      invite_revoked: "This invite link has been revoked. Ask the workspace admin for a fresh link.",
      invite_expired: "This invite link has expired. Ask the workspace admin for a fresh link.",
      invite_used_up: "This invite link has already been used the maximum number of times."
    };
    return new Response(await inviteErrorHtml("Invite unavailable", messages[payload.error ?? ""] ?? "This invite link is not available.").text(), {
      status,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  const inviteUrl = new URL(request.url);
  const inviteLink = `${inviteUrl.origin}/invite/${encodeURIComponent(token)}`;
  const installCommand = "npm install -g @ask-thane/thane-cli";
  const initCommand = "thane init";
  const acceptCommand = `thane invite-link accept ${inviteLink}`;
  const expires = new Date(row!.expires_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join ${escapeHtml(row!.workspace_name)} | Thane Chat</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f5f2; color: #24211c; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 32px 18px; box-sizing: border-box; }
    section { max-width: 760px; width: 100%; background: #fff; border: 1px solid #ded9cf; border-radius: 8px; padding: clamp(24px, 5vw, 44px); box-shadow: 0 18px 50px rgba(30, 28, 24, 0.08); }
    .eyebrow { margin: 0 0 12px; color: #7a7166; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
    h1 { margin: 0; font-size: clamp(32px, 6vw, 54px); line-height: 1.02; letter-spacing: 0; }
    .sub { margin: 16px 0 26px; color: #625a51; font-size: 18px; line-height: 1.55; max-width: 58ch; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 28px; }
    .pill { border: 1px solid #ded9cf; border-radius: 999px; padding: 7px 11px; color: #5b534a; background: #fbfaf8; font-size: 14px; }
    .steps { display: grid; gap: 14px; }
    .step { border-top: 1px solid #e8e4dd; padding-top: 16px; }
    .step h2 { margin: 0 0 8px; font-size: 16px; }
    .command-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: stretch; }
    pre { margin: 0; overflow-x: auto; border-radius: 8px; background: #20201d; color: #f5f1e8; padding: 14px 16px; font-size: 14px; line-height: 1.4; }
    button { border: 1px solid #2d2a26; border-radius: 8px; background: #2d2a26; color: white; padding: 0 14px; font: inherit; cursor: pointer; min-width: 76px; }
    button:hover { background: #11100e; }
    .note { margin: 24px 0 0; color: #6b6258; font-size: 14px; line-height: 1.5; }
    a { color: #2d2a26; font-weight: 700; }
    @media (max-width: 560px) { .command-row { grid-template-columns: 1fr; } button { min-height: 42px; } }
  </style>
</head>
<body>
  <main>
    <section>
      <p class="eyebrow">Thane Chat Invite</p>
      <h1>Join ${escapeHtml(row!.workspace_name)}</h1>
      <p class="sub">You have been invited to the ${escapeHtml(row!.workspace_name)} workspace in Thane Chat, a team chat interface that runs in your terminal.</p>
      <div class="meta">
        <span class="pill">Workspace: ${escapeHtml(row!.workspace_slug)}</span>
        <span class="pill">Role: ${escapeHtml(row!.role)}</span>
        <span class="pill">Expires: ${escapeHtml(expires)} UTC</span>
      </div>
      <div class="steps">
        <div class="step">
          <h2>1. Install the CLI</h2>
          <div class="command-row"><pre><code>${escapeHtml(installCommand)}</code></pre><button data-copy="${escapeHtml(installCommand)}">Copy</button></div>
        </div>
        <div class="step">
          <h2>2. Sign in or create your account</h2>
          <div class="command-row"><pre><code>${escapeHtml(initCommand)}</code></pre><button data-copy="${escapeHtml(initCommand)}">Copy</button></div>
        </div>
        <div class="step">
          <h2>3. Accept the invite</h2>
          <div class="command-row"><pre><code>${escapeHtml(acceptCommand)}</code></pre><button data-copy="${escapeHtml(acceptCommand)}">Copy</button></div>
        </div>
      </div>
      <p class="note">Already have Thane Chat installed? Run the accept command. Need the product page? Visit <a href="https://askthane.com/chat">askthane.com/chat</a>.</p>
    </section>
  </main>
  <script>
    for (const button of document.querySelectorAll("button[data-copy]")) {
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(button.dataset.copy || "");
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy"; }, 1400);
      });
    }
  </script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function shouldReturnDevCodes(env: Env): boolean {
  return env.THANE_CLI_AUTH_DEV_CODES === "true" || env.BUILD_ENV === "local";
}

function fromAddress(env: Env): string {
  return env.THANE_CLI_EMAIL_FROM?.trim() || "Thane <noreply@askthane.com>";
}

async function sendVerificationEmail(env: Env, input: { email: string; code: string }): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return false;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: fromAddress(env),
      to: input.email,
      subject: "Your Thane Chat verification code",
      text: `Your Thane Chat verification code is ${input.code}.\n\nThis code expires in 10 minutes.`
    })
  });

  if (!response.ok) {
    throw new Error(`Resend email failed with status ${response.status}`);
  }
  return true;
}

async function parseJsonObject<T>(request: Request): Promise<T | null> {
  try {
    const payload = await request.json();
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as T) : null;
  } catch (_error) {
    return null;
  }
}

async function handleThaneCliAuthStart(request: Request, env: Env): Promise<Response> {
  const payload = await parseJsonObject<AuthStartPayload>(request);
  const email = normalizeEmail(payload?.email);
  const displayName = normalizeDisplayName(payload?.displayName);
  if (!email) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  const code = makeVerificationCode();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const codeHash = await hashAuthCode(env, email, code);

  let delivery: "email" | "dev_code" = "email";
  try {
    const sent = await sendVerificationEmail(env, { email, code });
    if (!sent) {
      if (!shouldReturnDevCodes(env)) {
        return Response.json({ ok: false, error: "email_not_configured" }, { status: 503 });
      }
      delivery = "dev_code";
    }
  } catch (_error) {
    if (!shouldReturnDevCodes(env)) {
      return Response.json({ ok: false, error: "email_send_failed" }, { status: 502 });
    }
    delivery = "dev_code";
  }

  await env.DB
    .prepare(
      `INSERT INTO thane_cli_auth_codes (
         id, email, display_name, code_hash, delivery_channel, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(makeId("auth"), email, displayName, codeHash, delivery, createdAt, expiresAt)
    .run();

  return Response.json({
    ok: true,
    email,
    expiresAt,
    delivery,
    ...(delivery === "dev_code" ? { verificationCode: code } : {})
  });
}

async function handleThaneCliAuthVerify(request: Request, env: Env): Promise<Response> {
  const payload = await parseJsonObject<AuthVerifyPayload>(request);
  const email = normalizeEmail(payload?.email);
  const code = normalizeCode(payload?.code);
  if (!email || !code) {
    return Response.json({ ok: false, error: "invalid_email_or_code" }, { status: 400 });
  }

  const codeHash = await hashAuthCode(env, email, code);
  const authRow = await env.DB
    .prepare(
      `SELECT id, display_name, expires_at
       FROM thane_cli_auth_codes
       WHERE email = ? AND code_hash = ? AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(email, codeHash)
    .first<{ id?: string; display_name?: string | null; expires_at?: string }>();

  if (!authRow?.id || !authRow.expires_at) {
    return Response.json({ ok: false, error: "invalid_code" }, { status: 401 });
  }
  if (new Date(authRow.expires_at).getTime() < Date.now()) {
    return Response.json({ ok: false, error: "code_expired" }, { status: 401 });
  }

  const displayName =
    typeof authRow.display_name === "string" && authRow.display_name.trim()
      ? authRow.display_name.trim()
      : email.split("@")[0] || email;
  await env.DB
    .prepare("UPDATE thane_cli_auth_codes SET consumed_at = ? WHERE id = ?")
    .bind(nowIso(), authRow.id)
    .run();

  const mfaFactor = await activeMfaFactor(env, email);
  if (mfaFactor) {
    return Response.json({
      ok: true,
      mfaRequired: true,
      email,
      mfaChallengeToken: await signToken(env, {
        email,
        purpose: "mfa_challenge",
        exp: Math.floor(Date.now() / 1000) + 10 * 60
      })
    });
  }

  return Response.json({
    ok: true,
    account: await buildAccount(env, { email, displayName })
  });
}

async function handleThaneCliAuthMfaVerify(request: Request, env: Env): Promise<Response> {
  const payload = await parseJsonObject<MfaVerifyPayload>(request);
  const challenge = await verifyToken(env, payload?.challengeToken, "mfa_challenge");
  const code = normalizeCode(payload?.code);
  const email = normalizeEmail(challenge?.email);
  if (!email || !code) {
    return Response.json({ ok: false, error: "invalid_mfa_challenge" }, { status: 400 });
  }
  const factor = await activeMfaFactor(env, email);
  if (!factor) {
    return Response.json({ ok: false, error: "mfa_not_enabled" }, { status: 400 });
  }
  const secret = await decryptSecret(env, factor.secret_ciphertext);
  if (!(await verifyTotp(secret, code))) {
    return Response.json({ ok: false, error: "invalid_mfa_code" }, { status: 401 });
  }
  return Response.json({
    ok: true,
    account: await buildAccount(env, { email })
  });
}

async function handleThaneCliMfaStatus(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return Response.json({ ok: true, enabled: Boolean(await activeMfaFactor(env, email)) });
}

async function handleThaneCliMfaSetupStart(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const existing = await activeMfaFactor(env, email);
  if (existing) {
    return Response.json({ ok: false, error: "mfa_already_enabled" }, { status: 409 });
  }
  const secret = makeTotpSecret();
  const factorId = makeId("mfa");
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_mfa_factors (
         id, email, factor_type, secret_ciphertext, created_at
       ) VALUES (?, ?, 'totp', ?, ?)`
    )
    .bind(factorId, email, await encryptSecret(env, secret), nowIso())
    .run();
  return Response.json({
    ok: true,
    factorId,
    secret,
    otpauthUrl: `otpauth://totp/Thane%20Chat:${encodeURIComponent(email)}?secret=${secret}&issuer=Thane%20Chat&algorithm=SHA1&digits=6&period=30`
  });
}

async function handleThaneCliMfaSetupVerify(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<MfaSetupVerifyPayload>(request);
  const factorId = typeof payload?.factorId === "string" ? payload.factorId.trim() : "";
  const code = normalizeCode(payload?.code);
  if (!factorId || !code) {
    return Response.json({ ok: false, error: "factor_id_and_code_required" }, { status: 400 });
  }
  const row = await env.DB
    .prepare(
      `SELECT secret_ciphertext
       FROM thane_cli_mfa_factors
       WHERE id = ? AND email = ? AND factor_type = 'totp' AND enabled_at IS NULL AND disabled_at IS NULL`
    )
    .bind(factorId, email)
    .first<{ secret_ciphertext?: string }>();
  if (!row?.secret_ciphertext) {
    return Response.json({ ok: false, error: "mfa_setup_not_found" }, { status: 404 });
  }
  const secret = await decryptSecret(env, row.secret_ciphertext);
  if (!(await verifyTotp(secret, code))) {
    return Response.json({ ok: false, error: "invalid_mfa_code" }, { status: 401 });
  }
  await env.DB
    .prepare("UPDATE thane_cli_mfa_factors SET enabled_at = ? WHERE id = ?")
    .bind(nowIso(), factorId)
    .run();
  return Response.json({ ok: true, enabled: true });
}

async function handleThaneCliMfaDisable(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<MfaDisablePayload>(request);
  const code = normalizeCode(payload?.code);
  if (!code) {
    return Response.json({ ok: false, error: "code_required" }, { status: 400 });
  }
  const factor = await activeMfaFactor(env, email);
  if (!factor) {
    return Response.json({ ok: false, error: "mfa_not_enabled" }, { status: 400 });
  }
  const secret = await decryptSecret(env, factor.secret_ciphertext);
  if (!(await verifyTotp(secret, code))) {
    return Response.json({ ok: false, error: "invalid_mfa_code" }, { status: 401 });
  }
  await env.DB
    .prepare("UPDATE thane_cli_mfa_factors SET disabled_at = ? WHERE id = ?")
    .bind(nowIso(), factor.id)
    .run();
  return Response.json({ ok: true, enabled: false });
}

async function handleThaneCliWorkspaceInviteCreate(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<WorkspaceInviteCreatePayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim().slice(0, 120) : null;
  const workspaceSlug = normalizeWorkspaceSlug(payload?.workspaceSlug);
  const workspaceName =
    typeof payload?.workspaceName === "string" && payload.workspaceName.trim()
      ? payload.workspaceName.trim().slice(0, 120)
      : workspaceSlug;
  if (!workspaceId || !workspaceSlug || !workspaceName) {
    return Response.json({ ok: false, error: "workspace_id_slug_and_name_required" }, { status: 400 });
  }

  const role = normalizeWorkspaceRole(payload?.role);
  const expiresInHours = normalizePositiveInteger(payload?.expiresInHours, 24 * 7, 24 * 30);
  const maxUsesRaw = payload?.maxUses;
  const maxUses =
    maxUsesRaw === undefined || maxUsesRaw === null || maxUsesRaw === ""
      ? null
      : normalizePositiveInteger(maxUsesRaw, 0, 10_000);
  if (maxUses === 0) {
    return Response.json({ ok: false, error: "max_uses_must_be_positive" }, { status: 400 });
  }

  const token = makeInviteToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_workspace_invites (
         id, token_hash, workspace_id, workspace_slug, workspace_name, role,
         created_by_email, created_at, expires_at, max_uses
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(makeId("inv"), await hashInviteToken(token), workspaceId, workspaceSlug, workspaceName, role, email, createdAt, expiresAt, maxUses)
    .run();

  const url = `${inviteBaseUrl(env, request)}/${token}`;
  return Response.json({
    ok: true,
    invite: {
      url,
      token,
      workspace: { id: workspaceId, slug: workspaceSlug, name: workspaceName },
      role,
      expiresAt,
      maxUses
    }
  });
}

async function handleThaneCliWorkspaceInvitePreview(token: string, env: Env): Promise<Response> {
  const row = await inviteByToken(env, token);
  const invalid = validateInvite(row);
  if (invalid) {
    return invalid;
  }
  return Response.json({
    ok: true,
    invite: {
      workspace: renderInviteWorkspace(row!),
      role: row!.role,
      expiresAt: row!.expires_at
    }
  });
}

async function handleThaneCliWorkspaceInviteAccept(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<WorkspaceInviteAcceptPayload>(request);
  const token = extractInviteToken(payload?.token);
  if (!token) {
    return Response.json({ ok: false, error: "invite_token_required" }, { status: 400 });
  }
  const row = await inviteByToken(env, token);
  const invalid = validateInvite(row);
  if (invalid) {
    return invalid;
  }
  await env.DB
    .prepare("UPDATE thane_cli_workspace_invites SET accepted_count = accepted_count + 1 WHERE id = ?")
    .bind(row!.id)
    .run();
  return Response.json({
    ok: true,
    workspace: renderInviteWorkspace(row!),
    acceptedBy: email
  });
}

function isAuthorizedRequest(request: Request, env: Env): boolean {
  const expectedToken = env.INTERNAL_API_BEARER_TOKEN?.trim();
  if (!expectedToken) {
    return false;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const providedToken = authHeader.slice("bearer ".length).trim();
  return providedToken.length > 0 && providedToken === expectedToken;
}

function readAuthorizedOrganizationId(request: Request): string | null {
  const organizationId = request.headers.get("x-organization-id")?.trim();
  if (!organizationId) {
    return null;
  }
  return organizationId;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "ask-thane-api" });
    }

    if (url.pathname === "/build-info") {
      return Response.json({
        ok: true,
        service: "ask-thane-api",
        environment: env.BUILD_ENV ?? "unknown",
        gitSha: env.BUILD_GIT_SHA ?? "unknown",
        deployedAt: env.BUILD_DEPLOYED_AT ?? "unknown"
      });
    }

    if (url.pathname === "/v1/thane-cli/auth/start" && request.method === "POST") {
      return handleThaneCliAuthStart(request, env);
    }

    if (url.pathname === "/v1/thane-cli/auth/verify" && request.method === "POST") {
      return handleThaneCliAuthVerify(request, env);
    }

    if (url.pathname === "/v1/thane-cli/auth/mfa-verify" && request.method === "POST") {
      return handleThaneCliAuthMfaVerify(request, env);
    }

    if (url.pathname === "/v1/thane-cli/mfa/status" && request.method === "GET") {
      return handleThaneCliMfaStatus(request, env);
    }

    if (url.pathname === "/v1/thane-cli/mfa/setup/start" && request.method === "POST") {
      return handleThaneCliMfaSetupStart(request, env);
    }

    if (url.pathname === "/v1/thane-cli/mfa/setup/verify" && request.method === "POST") {
      return handleThaneCliMfaSetupVerify(request, env);
    }

    if (url.pathname === "/v1/thane-cli/mfa/disable" && request.method === "POST") {
      return handleThaneCliMfaDisable(request, env);
    }

    if (url.pathname === "/v1/thane-cli/workspace-invites" && request.method === "POST") {
      return handleThaneCliWorkspaceInviteCreate(request, env);
    }

    if (url.pathname === "/v1/thane-cli/workspace-invites/accept" && request.method === "POST") {
      return handleThaneCliWorkspaceInviteAccept(request, env);
    }

    if (url.pathname.startsWith("/v1/thane-cli/workspace-invites/") && request.method === "GET") {
      const token = url.pathname.split("/").filter(Boolean).at(-1);
      return token
        ? handleThaneCliWorkspaceInvitePreview(token, env)
        : Response.json({ ok: false, error: "invite_token_required" }, { status: 400 });
    }

    if (url.pathname.startsWith("/invite/") && request.method === "GET") {
      const token = url.pathname.split("/").filter(Boolean).at(-1);
      return token
        ? handleThaneCliWorkspaceInviteLanding(token, env, request)
        : Response.json({ ok: false, error: "invite_token_required" }, { status: 400 });
    }

    if (url.pathname.startsWith("/v1/tasks/") && !isAuthorizedRequest(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const authorizedOrganizationId =
      url.pathname.startsWith("/v1/tasks/") ? readAuthorizedOrganizationId(request) : null;
    if (url.pathname.startsWith("/v1/tasks/") && !authorizedOrganizationId) {
      return Response.json({ error: "missing organization scope" }, { status: 403 });
    }

    if (url.pathname === "/v1/tasks/open") {
      const workspaceId = url.searchParams.get("workspace_id") || "";
      const assigneeId = url.searchParams.get("assignee_id") || "";
      const organizationId = url.searchParams.get("organization_id")?.trim();

      if (!workspaceId || !assigneeId) {
        return Response.json(
          { error: "workspace_id and assignee_id are required" },
          { status: 400 }
        );
      }

      if (organizationId && organizationId !== authorizedOrganizationId) {
        return Response.json({ error: "organization scope mismatch" }, { status: 403 });
      }

      const repo = new D1TaskRepository(env.DB);
      const tasks = await repo.listOpenByAssigneeInOrganization(
        authorizedOrganizationId!,
        workspaceId,
        assigneeId
      );
      return Response.json({ tasks });
    }

    if (url.pathname === "/v1/tasks/open-visible") {
      const organizationId = url.searchParams.get("organization_id") || "";
      const assigneeId = url.searchParams.get("assignee_id") || "";
      const readableConversationSourceIds = (url.searchParams.get("readable_conversation_source_ids") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const allowUnscoped = url.searchParams.get("allow_unscoped") === "true";

      if (!organizationId || !assigneeId) {
        return Response.json(
          { error: "organization_id and assignee_id are required" },
          { status: 400 }
        );
      }

      if (organizationId !== authorizedOrganizationId) {
        return Response.json({ error: "organization scope mismatch" }, { status: 403 });
      }

      const repo = new D1TaskRepository(env.DB);
      const tasks = await repo.listOpenByAssigneeWithAcl({
        organizationId: authorizedOrganizationId!,
        assigneeId,
        readableConversationSourceIds,
        allowUnscoped
      });
      return Response.json({ tasks });
    }

    return new Response("Not Found", { status: 404 });
  }
};
