import { D1TaskRepository } from "@ask-thane/data";

interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  INTERNAL_API_BEARER_TOKEN?: string;
  THANE_CLI_AUTH_DEV_CODES?: string;
  THANE_CLI_AUTH_SECRET?: string;
  THANE_CLI_EMAIL_FROM?: string;
  THANE_CLI_INVITE_BASE_URL?: string;
  THANE_CLI_WEB_INVITE_BASE_URL?: string;
  BUILD_ENV?: string;
  BUILD_GIT_SHA?: string;
  BUILD_DEPLOYED_AT?: string;
}

interface AuthStartPayload {
  email?: unknown;
  displayName?: unknown;
}

interface ProfileUpdatePayload {
  displayName?: unknown;
}

interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
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
  inviteeEmail?: unknown;
  role?: unknown;
  expiresInHours?: unknown;
  maxUses?: unknown;
}

interface WorkspaceInviteAcceptPayload {
  token?: unknown;
}

interface ThaneCliWorkspaceEnsurePayload {
  workspaceId?: unknown;
  workspaceSlug?: unknown;
  workspaceName?: unknown;
  asciiArt?: unknown;
}

interface ThaneCliChannelCreatePayload {
  workspaceId?: unknown;
  name?: unknown;
  topic?: unknown;
  private?: unknown;
}

interface ThaneCliMessageCreatePayload {
  workspaceId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  text?: unknown;
  source?: unknown;
  threadRootId?: unknown;
}

interface ThaneCliReactionCreatePayload {
  workspaceId?: unknown;
  messageId?: unknown;
  emoji?: unknown;
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

function normalizeChannelName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name ? name.slice(0, 80) : null;
}

function normalizeHandleFromEmail(email: string): string {
  return email.split("@")[0]?.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 80) || "user";
}

function normalizeChatText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text.slice(0, 8000) : null;
}

function normalizeAsciiArt(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.replace(/\s+$/g, "")).join("\n").trim();
  return trimmed ? trimmed.slice(0, 1200) : null;
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

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowedOrigins = new Set([
    "https://chat.askthane.com",
    "https://askthane.com",
    "https://www.askthane.com",
    "http://localhost:8787",
    "http://127.0.0.1:8787"
  ]);
  const allowOrigin = allowedOrigins.has(origin) ? origin : "https://chat.askthane.com";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function makeVerificationCode(): string {
  const randomValues = new Uint32Array(1);
  crypto.getRandomValues(randomValues);
  return String((randomValues[0] ?? 0) % 1_000_000).padStart(6, "0");
}

function requestIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct) {
    return direct.slice(0, 120);
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || "unknown").slice(0, 120);
}

async function checkRateLimit(env: Env, input: {
  purpose: string;
  key: string;
  keyHint?: string;
  limit: number;
  windowSeconds: number;
  nowMs?: number;
}): Promise<RateLimitResult> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const keyHash = await sha256Hex(`thane_rate_limit:${input.purpose}:${input.key}`);
  const row = await env.DB
    .prepare(
      `SELECT id, window_started_at, count
       FROM thane_cli_rate_limits
       WHERE purpose = ? AND key_hash = ?
       LIMIT 1`
    )
    .bind(input.purpose, keyHash)
    .first<{ id?: string; window_started_at?: string; count?: number }>();

  const existingWindowMs = row?.window_started_at ? new Date(row.window_started_at).getTime() : Number.NaN;
  const isCurrentWindow = Number.isFinite(existingWindowMs) && nowMs - existingWindowMs < input.windowSeconds * 1000;
  const currentCount = Number(row?.count ?? 0);
  if (row?.id && isCurrentWindow && currentCount >= input.limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((input.windowSeconds * 1000 - (nowMs - existingWindowMs)) / 1000))
    };
  }

  if (row?.id && isCurrentWindow) {
    await env.DB
      .prepare("UPDATE thane_cli_rate_limits SET count = count + 1, updated_at = ? WHERE id = ?")
      .bind(now.toISOString(), row.id)
      .run();
    return { ok: true };
  }

  if (row?.id) {
    await env.DB
      .prepare("UPDATE thane_cli_rate_limits SET window_started_at = ?, count = 1, updated_at = ?, key_hint = ? WHERE id = ?")
      .bind(now.toISOString(), now.toISOString(), input.keyHint ?? null, row.id)
      .run();
    return { ok: true };
  }

  await env.DB
    .prepare(
      `INSERT INTO thane_cli_rate_limits (
         id, purpose, key_hash, key_hint, window_started_at, count, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .bind(makeId("rl"), input.purpose, keyHash, input.keyHint ?? null, now.toISOString(), now.toISOString())
    .run();
  return { ok: true };
}

async function enforceAuthEmailRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  const nowMs = Date.now();
  const emailLimit = await checkRateLimit(env, {
    purpose: "thane_cli_auth_email:email",
    key: email,
    keyHint: email,
    limit: 5,
    windowSeconds: 60 * 60,
    nowMs
  });
  if (!emailLimit.ok) {
    return Response.json(
      { ok: false, error: "rate_limited", retryAfterSeconds: emailLimit.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(emailLimit.retryAfterSeconds ?? 60) } }
    );
  }

  const ip = requestIp(request);
  const ipLimit = await checkRateLimit(env, {
    purpose: "thane_cli_auth_email:ip",
    key: ip,
    ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
    limit: 30,
    windowSeconds: 60 * 60,
    nowMs
  });
  if (!ipLimit.ok) {
    return Response.json(
      { ok: false, error: "rate_limited", retryAfterSeconds: ipLimit.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(ipLimit.retryAfterSeconds ?? 60) } }
    );
  }
  return null;
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
  const savedDisplayName = input.displayName?.trim() || (await profileDisplayNameForEmail(env, input.email));
  const displayName = savedDisplayName || input.email.split("@")[0] || input.email;
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

async function profileDisplayNameForEmail(env: Env, email: string): Promise<string | null> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT display_name
         FROM thane_cli_workspace_members
         WHERE email = ? AND display_name IS NOT NULL AND display_name != ''
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .bind(email)
      .first<{ display_name?: string | null }>();
    return row?.display_name?.trim() || null;
  } catch (error) {
    if (String(error).toLowerCase().includes("no such table")) {
      return null;
    }
    throw error;
  }
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

function webInviteBaseUrl(env: Env): string {
  return env.THANE_CLI_WEB_INVITE_BASE_URL?.trim().replace(/\/+$/g, "") || "https://chat.askthane.com/invite";
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
  try {
    return await env.DB
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
  } catch (error) {
    if (String(error).toLowerCase().includes("no such table")) {
      return null;
    }
    throw error;
  }
}

async function ensureThaneCliWorkspace(env: Env, input: {
  workspaceId?: string | null;
  workspaceSlug: string;
  workspaceName: string;
  asciiArt?: string | null;
  email: string;
  role: "owner" | "admin" | "member";
}): Promise<{ id: string; slug: string; name: string; asciiArt?: string | null }> {
  const createdAt = nowIso();
  const requestedId = input.workspaceId?.trim().slice(0, 120) || makeId("tcw");
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_workspaces (
         id, workspace_slug, workspace_name, ascii_art, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_slug) DO UPDATE SET
         workspace_name = excluded.workspace_name,
         ascii_art = COALESCE(excluded.ascii_art, thane_cli_workspaces.ascii_art),
         updated_at = excluded.updated_at`
    )
    .bind(requestedId, input.workspaceSlug, input.workspaceName, input.asciiArt ?? null, createdAt, createdAt)
    .run();

  const workspace = await env.DB
    .prepare(
      `SELECT id, workspace_slug, workspace_name, ascii_art
       FROM thane_cli_workspaces
       WHERE workspace_slug = ?
       LIMIT 1`
    )
    .bind(input.workspaceSlug)
    .first<{ id?: string; workspace_slug?: string; workspace_name?: string | null; ascii_art?: string | null }>();
  if (!workspace?.id || !workspace.workspace_slug) {
    throw new Error("workspace_upsert_failed");
  }

  await ensureThaneCliMember(env, {
    workspaceId: workspace.id,
    email: input.email,
    displayName: normalizeHandleFromEmail(input.email),
    role: input.role
  });
  await ensureThaneCliChannel(env, workspace.id, "general", "Community-wide conversation");

  return {
    id: workspace.id,
    slug: workspace.workspace_slug,
    name: workspace.workspace_name || workspace.workspace_slug,
    asciiArt: workspace.ascii_art ?? null
  };
}

async function ensureThaneCliMember(env: Env, input: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
  role: "owner" | "admin" | "member";
}): Promise<{ id: string; accountId: string; email: string; handle: string; displayName: string; role: string }> {
  const accountId = await accountIdForEmail(input.email);
  const handle = normalizeHandleFromEmail(input.email);
  const displayName = input.displayName?.trim() || handle.charAt(0).toUpperCase() + handle.slice(1);
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_workspace_members (
         id, workspace_id, account_id, email, display_name, handle, role, joined_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         account_id = excluded.account_id,
         display_name = excluded.display_name,
         handle = excluded.handle,
         role = CASE
           WHEN thane_cli_workspace_members.role = 'owner' THEN 'owner'
           ELSE excluded.role
         END,
         updated_at = excluded.updated_at`
    )
    .bind(makeId("tcm"), input.workspaceId, accountId, input.email, displayName, handle, input.role, now, now)
    .run();
  const row = await env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle, role
       FROM thane_cli_workspace_members
       WHERE workspace_id = ? AND email = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.email)
    .first<{ id?: string; account_id?: string; email?: string; display_name?: string | null; handle?: string; role?: string }>();
  if (!row?.id || !row.account_id || !row.email || !row.handle || !row.role) {
    throw new Error("member_upsert_failed");
  }
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    handle: row.handle,
    displayName: row.display_name || row.handle,
    role: row.role
  };
}

async function ensureThaneCliChannel(
  env: Env,
  workspaceId: string,
  name: string,
  topic?: string | null,
  visibility: "public" | "private" = "public"
): Promise<{ id: string; workspaceId: string; name: string; visibility: "public" | "private"; topic?: string | null; createdAt: string }> {
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_channels (
         id, workspace_id, name, kind, visibility, topic, created_at, updated_at
       ) VALUES (?, ?, ?, 'channel', ?, ?, ?, ?)
       ON CONFLICT(workspace_id, name) DO UPDATE SET
         topic = COALESCE(excluded.topic, thane_cli_channels.topic),
         visibility = excluded.visibility,
         updated_at = excluded.updated_at`
    )
    .bind(makeId("tcc"), workspaceId, name, visibility, topic ?? null, now, now)
    .run();
  const row = await env.DB
    .prepare(
      `SELECT id, workspace_id, name, visibility, topic, created_at
       FROM thane_cli_channels
       WHERE workspace_id = ? AND name = ?
       LIMIT 1`
    )
    .bind(workspaceId, name)
    .first<{ id?: string; workspace_id?: string; name?: string; visibility?: "public" | "private"; topic?: string | null; created_at?: string }>();
  if (!row?.id || !row.workspace_id || !row.name || !row.visibility || !row.created_at) {
    throw new Error("channel_upsert_failed");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    visibility: row.visibility,
    ...(row.topic ? { topic: row.topic } : {}),
    createdAt: row.created_at
  };
}

async function requireThaneCliWorkspaceMember(
  env: Env,
  workspaceId: string,
  email: string
): Promise<{ id: string; account_id: string; email: string; display_name: string | null; handle: string; role: string } | null> {
  return env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle, role
       FROM thane_cli_workspace_members
       WHERE workspace_id = ? AND email = ?
       LIMIT 1`
    )
    .bind(workspaceId, email)
    .first<{ id: string; account_id: string; email: string; display_name: string | null; handle: string; role: string }>();
}

function isThaneCliWorkspaceAdmin(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
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
  const webInviteLink = `${webInviteBaseUrl(env)}/${encodeURIComponent(token)}`;
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
    .primary { display: inline-flex; align-items: center; justify-content: center; min-height: 46px; border-radius: 8px; background: #2d2a26; color: #fff; padding: 0 18px; text-decoration: none; font-weight: 700; margin-bottom: 26px; }
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
      <p class="sub">You have been invited to the ${escapeHtml(row!.workspace_name)} workspace in Thane Chat.</p>
      <div class="meta">
        <span class="pill">Workspace: ${escapeHtml(row!.workspace_slug)}</span>
        <span class="pill">Role: ${escapeHtml(row!.role)}</span>
        <span class="pill">Expires: ${escapeHtml(expires)} UTC</span>
      </div>
      <a class="primary" href="${escapeHtml(webInviteLink)}">Accept in Thane Chat</a>
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
      <p class="note">No install is required for the web app. Already have Thane Chat installed? Run the accept command instead.</p>
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
  if (!env.EMAIL) {
    return false;
  }

  await env.EMAIL.send({
    from: fromAddress(env),
    to: input.email,
    subject: "Your Thane Chat verification code",
    text: `Your Thane Chat verification code is ${input.code}.\n\nThis code expires in 10 minutes.`
  });
  return true;
}

async function sendWorkspaceInviteEmail(
  env: Env,
  input: {
    email: string;
    invitedBy: string;
    workspaceName: string;
    workspaceSlug: string;
    role: "admin" | "member";
    url: string;
    cliUrl?: string;
    expiresAt: string;
  }
): Promise<boolean> {
  if (!env.EMAIL) {
    return false;
  }

  await env.EMAIL.send({
    from: fromAddress(env),
    to: input.email,
    subject: `${input.invitedBy} invited you to ${input.workspaceName} on Thane Chat`,
    text:
      `${input.invitedBy} invited you to join ${input.workspaceName} (${input.workspaceSlug}) on Thane Chat as ${input.role}.\n\n` +
      `Accept the invite in your browser:\n${input.url}\n\n` +
      `CLI fallback:\nnpm install -g @ask-thane/thane-cli\nthane init\nthane invite-link accept ${input.cliUrl ?? input.url}\n\n` +
      `This invite expires ${input.expiresAt}.`
  });
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
  const rateLimited = await enforceAuthEmailRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
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

async function handleThaneCliProfileUpdate(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ProfileUpdatePayload>(request);
  const displayName = normalizeDisplayName(payload?.displayName);
  if (!displayName) {
    return Response.json({ ok: false, error: "display_name_required" }, { status: 400 });
  }
  await env.DB
    .prepare("UPDATE thane_cli_workspace_members SET display_name = ?, updated_at = ? WHERE email = ?")
    .bind(displayName, nowIso(), email)
    .run();
  return Response.json({
    ok: true,
    account: await buildAccount(env, { email, displayName }),
    displayName
  });
}

async function handleThaneCliWorkspaceEnsure(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliWorkspaceEnsurePayload>(request);
  const workspaceSlug = normalizeWorkspaceSlug(payload?.workspaceSlug);
  const workspaceName =
    typeof payload?.workspaceName === "string" && payload.workspaceName.trim()
      ? payload.workspaceName.trim().slice(0, 120)
      : workspaceSlug;
  if (!workspaceSlug || !workspaceName) {
    return Response.json({ ok: false, error: "workspace_slug_required" }, { status: 400 });
  }
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim().slice(0, 120) : null;
  const workspace = await ensureThaneCliWorkspace(env, {
    workspaceId,
    workspaceSlug,
    workspaceName,
    asciiArt: normalizeAsciiArt(payload?.asciiArt),
    email,
    role: "owner"
  });
  return Response.json({ ok: true, workspace });
}

async function buildThaneCliSyncResponse(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const requestedWorkspaceId = url.searchParams.get("workspaceId")?.trim() || null;
  const workspaceRows = await env.DB
    .prepare(
      `SELECT w.id, w.workspace_slug, w.workspace_name, w.ascii_art, w.created_at, m.role
       FROM thane_cli_workspace_members m
       JOIN thane_cli_workspaces w ON w.id = m.workspace_id
       WHERE m.email = ? AND w.status = 'active'
       ORDER BY w.workspace_slug`
    )
    .bind(email)
    .all<{ id: string; workspace_slug: string; workspace_name: string | null; ascii_art: string | null; created_at: string; role: string }>();

  const workspaces = (workspaceRows.results ?? []).map((row) => ({
    id: row.id,
    slug: row.workspace_slug,
    name: row.workspace_name || row.workspace_slug,
    createdAt: row.created_at,
    ...(row.ascii_art ? { asciiArt: row.ascii_art } : {})
  }));
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === requestedWorkspaceId || workspace.slug === requestedWorkspaceId) ?? workspaces[0];
  const account = await buildAccount(env, { email });
  if (!activeWorkspace) {
    return Response.json({
      ok: true,
      account,
      activeWorkspaceId: null,
      workspaces: [],
      workspaceMembers: [],
      users: [],
      channels: [],
      messages: []
    });
  }

  const memberRows = await env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle, role, joined_at
       FROM thane_cli_workspace_members
       WHERE workspace_id = ?
       ORDER BY handle`
    )
    .bind(activeWorkspace.id)
    .all<{ id: string; account_id: string; email: string; display_name: string | null; handle: string; role: "owner" | "admin" | "member"; joined_at: string }>();
  const members = memberRows.results ?? [];
  const memberIds = members.map((member) => member.id);
  const users = members.map((member) => ({
    id: member.id,
    workspaceId: activeWorkspace.id,
    accountId: member.account_id,
    handle: member.handle,
    displayName: member.display_name || member.handle,
    email: member.email
  }));
  const workspaceMembers = members.map((member) => ({
    id: member.id,
    workspaceId: activeWorkspace.id,
    accountId: member.account_id,
    userId: member.id,
    role: member.role,
    joinedAt: member.joined_at
  }));

  const channelRows = await env.DB
    .prepare(
      `SELECT id, workspace_id, name, kind, visibility, topic, created_at
       FROM thane_cli_channels
       WHERE workspace_id = ?
       ORDER BY name`
    )
    .bind(activeWorkspace.id)
    .all<{ id: string; workspace_id: string; name: string; kind: "channel" | "dm"; visibility: "public" | "private"; topic: string | null; created_at: string }>();
  const channels = (channelRows.results ?? []).map((channel) => ({
    id: channel.id,
    workspaceId: channel.workspace_id,
    name: channel.name,
    kind: channel.kind,
    visibility: channel.visibility,
    memberIds,
    ...(channel.topic ? { topic: channel.topic } : {}),
    createdAt: channel.created_at
  }));

  const messageRows = await env.DB
    .prepare(
      `SELECT msg.id, msg.workspace_id, msg.channel_id, msg.author_member_id, msg.text, msg.source, msg.thread_root_id, msg.created_at
       FROM thane_cli_chat_messages msg
       JOIN thane_cli_channels c ON c.id = msg.channel_id
       WHERE msg.workspace_id = ?
       ORDER BY msg.created_at DESC
       LIMIT 300`
    )
    .bind(activeWorkspace.id)
    .all<{
      id: string;
      workspace_id: string;
      channel_id: string;
      author_member_id: string;
      text: string;
      source: "chat" | "terminal";
      thread_root_id: string | null;
      created_at: string;
    }>();
  const messageResults = messageRows.results ?? [];
  const messageIds = messageResults.map((message) => message.id);
  const reactionsByMessage = new Map<string, Array<{ emoji: string; by: string; createdAt: string }>>();
  if (messageIds.length > 0) {
    const reactionRows = await env.DB
      .prepare(
        `SELECT reaction.message_id, reaction.emoji, reaction.created_at, member.handle
         FROM thane_cli_message_reactions reaction
         JOIN thane_cli_workspace_members member ON member.id = reaction.member_id
         WHERE reaction.message_id IN (${messageIds.map(() => "?").join(", ")})
         ORDER BY reaction.created_at ASC`
      )
      .bind(...messageIds)
      .all<{ message_id: string; emoji: string; created_at: string; handle: string }>();
    for (const reaction of reactionRows.results ?? []) {
      const reactions = reactionsByMessage.get(reaction.message_id) ?? [];
      reactions.push({
        emoji: reaction.emoji,
        by: reaction.handle,
        createdAt: reaction.created_at
      });
      reactionsByMessage.set(reaction.message_id, reactions);
    }
  }
  const messages = (messageRows.results ?? []).reverse().map((message) => ({
    id: message.id,
    workspaceId: message.workspace_id,
    channelId: message.channel_id,
    authorId: message.author_member_id,
    text: message.text,
    createdAt: message.created_at,
    source: message.source,
    ...(message.thread_root_id ? { threadRootId: message.thread_root_id } : {}),
    reactions: reactionsByMessage.get(message.id) ?? [],
    mentions: [...message.text.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((match) => String(match[1] ?? "").toLowerCase()).filter(Boolean)
  }));

  return Response.json({
    ok: true,
    account,
    activeWorkspaceId: activeWorkspace.id,
    workspaces,
    workspaceMembers,
    users,
    channels,
    messages
  });
}

async function handleThaneCliChannelCreate(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliChannelCreatePayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const name = normalizeChannelName(payload?.name);
  if (!workspaceId || !name) {
    return Response.json({ ok: false, error: "workspace_id_and_channel_name_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const channel = await ensureThaneCliChannel(
    env,
    workspaceId,
    name,
    typeof payload?.topic === "string" && payload.topic.trim() ? payload.topic.trim().slice(0, 200) : null,
    payload?.private ? "private" : "public"
  );
  if (channel.visibility === "private") {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO thane_cli_channel_members (id, channel_id, member_id, joined_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(makeId("tccm"), channel.id, member.id, nowIso())
      .run();
  }
  return Response.json({ ok: true, channel });
}

async function handleThaneCliMessageCreate(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliMessageCreatePayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const text = normalizeChatText(payload?.text);
  if (!workspaceId || !text) {
    return Response.json({ ok: false, error: "workspace_id_and_text_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const channelId = typeof payload?.channelId === "string" && payload.channelId.trim() ? payload.channelId.trim() : null;
  const channelName = normalizeChannelName(payload?.channelName);
  const channel = channelId
    ? await env.DB
        .prepare("SELECT id, name FROM thane_cli_channels WHERE workspace_id = ? AND id = ? LIMIT 1")
        .bind(workspaceId, channelId)
        .first<{ id: string; name: string }>()
    : channelName
    ? await ensureThaneCliChannel(env, workspaceId, channelName)
    : null;
  if (!channel?.id) {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  const createdAt = nowIso();
  const messageId = makeId("tmsg");
  const source = payload?.source === "terminal" ? "terminal" : "chat";
  const threadRootId = typeof payload?.threadRootId === "string" && payload.threadRootId.trim() ? payload.threadRootId.trim() : null;
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_chat_messages (
         id, workspace_id, channel_id, author_member_id, text, source, thread_root_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(messageId, workspaceId, channel.id, member.id, text, source, threadRootId, createdAt, createdAt)
    .run();
  return Response.json({
    ok: true,
    message: {
      id: messageId,
      workspaceId,
      channelId: channel.id,
      authorId: member.id,
      text,
      source,
      ...(threadRootId ? { threadRootId } : {}),
      createdAt,
      reactions: [],
      mentions: [...text.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((match) => String(match[1] ?? "").toLowerCase()).filter(Boolean)
    }
  });
}

async function handleThaneCliReactionCreate(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliReactionCreatePayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const messageId = typeof payload?.messageId === "string" && payload.messageId.trim() ? payload.messageId.trim() : null;
  const emoji = typeof payload?.emoji === "string" && payload.emoji.trim() ? payload.emoji.trim().slice(0, 40) : null;
  if (!workspaceId || !messageId || !emoji) {
    return Response.json({ ok: false, error: "workspace_id_message_id_and_emoji_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const message = await env.DB
    .prepare("SELECT id FROM thane_cli_chat_messages WHERE workspace_id = ? AND id = ? LIMIT 1")
    .bind(workspaceId, messageId)
    .first<{ id: string }>();
  if (!message?.id) {
    return Response.json({ ok: false, error: "message_not_found" }, { status: 404 });
  }
  const createdAt = nowIso();
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO thane_cli_message_reactions (id, message_id, member_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(makeId("trxn"), messageId, member.id, emoji, createdAt)
    .run();
  return Response.json({ ok: true, reaction: { emoji, by: member.handle, createdAt } });
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
  const inviteeEmail = normalizeEmail(payload?.inviteeEmail);
  const workspaceRow = await env.DB
    .prepare(
      `SELECT id, workspace_slug, workspace_name, ascii_art
       FROM thane_cli_workspaces
       WHERE id = ?
       LIMIT 1`
    )
    .bind(workspaceId)
    .first<{ id?: string; workspace_slug?: string; workspace_name?: string | null; ascii_art?: string | null }>();
  if (!workspaceRow?.id || !workspaceRow.workspace_slug) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceRow.id, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  if (!isThaneCliWorkspaceAdmin(member.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const workspace = {
    id: workspaceRow.id,
    slug: workspaceRow.workspace_slug,
    name: workspaceRow.workspace_name || workspaceName || workspaceRow.workspace_slug,
    asciiArt: workspaceRow.ascii_art ?? null
  };

  const role = normalizeWorkspaceRole(payload?.role);
  const expiresInHours = normalizePositiveInteger(payload?.expiresInHours, 24 * 7, 24 * 30);
  const maxUsesRaw = payload?.maxUses;
  const maxUses =
    inviteeEmail && (maxUsesRaw === undefined || maxUsesRaw === null || maxUsesRaw === "")
      ? 1
      : maxUsesRaw === undefined || maxUsesRaw === null || maxUsesRaw === ""
      ? null
      : normalizePositiveInteger(maxUsesRaw, 0, 10_000);
  if (maxUses === 0) {
    return Response.json({ ok: false, error: "max_uses_must_be_positive" }, { status: 400 });
  }
  if (inviteeEmail) {
    const creatorLimit = await checkRateLimit(env, {
      purpose: "thane_cli_invite_email:creator",
      key: email,
      keyHint: email,
      limit: 30,
      windowSeconds: 60 * 60
    });
    if (!creatorLimit.ok) {
      return Response.json(
        { ok: false, error: "rate_limited", retryAfterSeconds: creatorLimit.retryAfterSeconds },
        { status: 429, headers: { "retry-after": String(creatorLimit.retryAfterSeconds ?? 60) } }
      );
    }
    const recipientLimit = await checkRateLimit(env, {
      purpose: "thane_cli_invite_email:recipient",
      key: inviteeEmail,
      keyHint: inviteeEmail,
      limit: 10,
      windowSeconds: 60 * 60
    });
    if (!recipientLimit.ok) {
      return Response.json(
        { ok: false, error: "rate_limited", retryAfterSeconds: recipientLimit.retryAfterSeconds },
        { status: 429, headers: { "retry-after": String(recipientLimit.retryAfterSeconds ?? 60) } }
      );
    }
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
    .bind(makeId("inv"), await hashInviteToken(token), workspace.id, workspace.slug, workspace.name, role, email, createdAt, expiresAt, maxUses)
    .run();

  const url = `${inviteBaseUrl(env, request)}/${token}`;
  const webUrl = `${webInviteBaseUrl(env)}/${token}`;
  const emailSent = inviteeEmail
    ? await sendWorkspaceInviteEmail(env, {
        email: inviteeEmail,
        invitedBy: email,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
        role,
        url: webUrl,
        cliUrl: url,
        expiresAt
      })
    : false;
  if (inviteeEmail && !emailSent && !shouldReturnDevCodes(env)) {
    return Response.json({ ok: false, error: "email_send_failed" }, { status: 502 });
  }
  return Response.json({
    ok: true,
    invite: {
      url,
      token,
      webUrl,
      workspace,
      role,
      expiresAt,
      maxUses,
      ...(inviteeEmail ? { inviteeEmail, emailSent } : {})
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
  await ensureThaneCliMember(env, {
    workspaceId: row!.workspace_id,
    email,
    displayName: normalizeHandleFromEmail(email),
    role: row!.role
  });
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

async function handleThaneCliRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/thane-cli/")) {
    return null;
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
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
  if (url.pathname === "/v1/thane-cli/profile" && request.method === "POST") {
    return handleThaneCliProfileUpdate(request, env);
  }
  if (url.pathname === "/v1/thane-cli/workspaces" && request.method === "POST") {
    return handleThaneCliWorkspaceEnsure(request, env);
  }
  if (url.pathname === "/v1/thane-cli/sync" && request.method === "GET") {
    return buildThaneCliSyncResponse(request, env);
  }
  if (url.pathname === "/v1/thane-cli/channels" && request.method === "POST") {
    return handleThaneCliChannelCreate(request, env);
  }
  if (url.pathname === "/v1/thane-cli/messages" && request.method === "POST") {
    return handleThaneCliMessageCreate(request, env);
  }
  if (url.pathname === "/v1/thane-cli/reactions" && request.method === "POST") {
    return handleThaneCliReactionCreate(request, env);
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
  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
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

    const thaneCliResponse = await handleThaneCliRequest(request, env);
    if (thaneCliResponse) {
      return withCors(thaneCliResponse, request);
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
