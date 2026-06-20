import { createLlmClient } from "@ask-thane/ai";
import { D1TaskRepository } from "@ask-thane/data";
import type { MessageEvent } from "@ask-thane/domain";
import { ingestMessageForTasks } from "@ask-thane/workflows";
import { DurableObject } from "cloudflare:workers";
import * as QRCode from "qrcode";

interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  THANE_CHAT_EVENTS?: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  BILLING_LINK_SIGNING_SECRET?: string;
  DEFAULT_LLM_MODEL?: string;
  DEFAULT_LLM_PROVIDER?: "openai" | "anthropic";
  INTERNAL_API_BEARER_TOKEN?: string;
  OPENAI_API_KEY?: string;
  FREE_TIER_MONTHLY_AI_CAP_USD?: string;
  THANE_BOT_INTERNAL_BASE_URL?: string;
  THANE_CLI_AUTH_DEV_CODES?: string;
  THANE_CLI_AUTH_SECRET?: string;
  THANE_CLI_EMAIL_FROM?: string;
  THANE_CLI_INVITE_BASE_URL?: string;
  THANE_CLI_WEB_INVITE_BASE_URL?: string;
  THANE_PAYMENTS_BASE_URL?: string;
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
  handle?: unknown;
  scope?: unknown;
  workspaceId?: unknown;
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

interface MfaSetupQrCodes {
  qrSvg: string;
  qrTerminal: string;
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

interface ThaneCliBillingLinkPayload {
  workspaceId?: unknown;
  returnUrl?: unknown;
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

interface ThaneCliChannelMembershipPayload {
  workspaceId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  target?: unknown;
}

interface ThaneCliMessageCreatePayload {
  workspaceId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  text?: unknown;
  source?: unknown;
  threadRootId?: unknown;
}

interface ThaneCliAskThanePayload {
  workspaceId?: unknown;
}

interface ThaneCliReactionCreatePayload {
  workspaceId?: unknown;
  messageId?: unknown;
  emoji?: unknown;
}

interface ThaneCliWorkspaceMembershipPayload {
  workspaceId?: unknown;
  target?: unknown;
  role?: unknown;
  reason?: unknown;
}

interface TokenPayload {
  email: string;
  exp: number;
  purpose: "auth" | "mfa_challenge";
}

const THANE_CLI_FREE_LIMITS = {
  members: 100,
  privateChannels: 10,
  historyDays: 90
} as const;

type ThaneCliPlanTier = "free" | "cli_team";

interface ThaneChatPushEvent {
  type: "message_created" | "reaction_created" | "workspace_changed";
  workspaceId: string;
  channelId?: string;
  messageId?: string;
  occurredAt: string;
}

export class ThaneChatEvents extends DurableObject {
  private readonly sockets = new Set<WebSocket>();
  private readonly streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly encoder = new TextEncoder();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/broadcast") && request.method === "POST") {
      return this.broadcast(request);
    }
    if (url.pathname.endsWith("/stream") && request.method === "GET") {
      return this.stream();
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) {
      return new Response("Unable to create WebSocket pair", { status: 500 });
    }
    server.accept();
    this.sockets.add(server);
    const close = () => this.sockets.delete(server);
    server.addEventListener("close", close);
    server.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(request: Request): Promise<Response> {
    const event = (await request.json().catch(() => null)) as ThaneChatPushEvent | null;
    if (!event?.workspaceId || !event.type) {
      return Response.json({ ok: false, error: "invalid_event" }, { status: 400 });
    }
    const payload = JSON.stringify(event);
    for (const socket of [...this.sockets]) {
      try {
        socket.send(payload);
      } catch (_error) {
        this.sockets.delete(socket);
      }
    }
    this.broadcastToStreams(event);
    return Response.json({ ok: true, clients: this.sockets.size + this.streams.size });
  }

  private stream(): Response {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
        this.streams.add(controller);
        this.sendStreamEvent(controller, {
          type: "connected",
          occurredAt: new Date().toISOString()
        });
      },
      cancel: () => {
        if (streamController) {
          this.streams.delete(streamController);
        }
      }
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform"
      }
    });
  }

  private broadcastToStreams(event: ThaneChatPushEvent): void {
    for (const controller of [...this.streams]) {
      this.sendStreamEvent(controller, event);
    }
  }

  private sendStreamEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: ThaneChatPushEvent | { type: "connected"; occurredAt: string }
  ): void {
    try {
      controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch (_error) {
      this.streams.delete(controller);
    }
  }
}

interface ThaneCliAskThaneIntegrationRow {
  workspace_id: string;
  enabled: number;
  bot_member_id: string | null;
  linked_account_email: string | null;
  connected_at: string;
  updated_at: string;
  last_event_at: string | null;
}

interface NativeAgentRefs {
  organizationId: string;
  workspaceId: string;
  userId: string;
  conversationSourceId: string;
}

type ThaneCliConversationKind = "channel" | "dm";
type ThaneCliConversationVisibility = "public" | "private";

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

function normalizeWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/\s+/g, " ");
  return name ? name.slice(0, 120) : null;
}

function workspaceSlugFromName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const handle = value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return handle ? handle.slice(0, 32) : null;
}

function publicHandleForAccountId(accountId: string): string {
  return `user-${accountId.replace(/^acct_/, "").slice(0, 8) || "member"}`;
}

function fallbackDisplayNameForAccountId(accountId: string): string {
  const suffix = accountId.replace(/^acct_/, "").slice(0, 6).toUpperCase();
  return suffix ? `Member ${suffix}` : "Member";
}

function emailLocalPartLooksIdentifying(localPart: string): boolean {
  return /[._+-]|\d/.test(localPart) || localPart.length > 16;
}

function isLegacyEmailDerivedIdentity(email: string, value: string | null | undefined): boolean {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  const localPart = email.split("@")[0]?.trim().toLowerCase() || "";
  if (!emailLocalPartLooksIdentifying(localPart)) {
    return false;
  }
  const normalizedLegacy = normalizeHandleFromEmail(email);
  const normalizedValue = normalizeHandle(trimmed);
  return trimmed === localPart || normalizedValue === normalizedLegacy;
}

function publicHandleForMember(member: { account_id?: string | null | undefined; email?: string | null | undefined; handle?: string | null | undefined }): string {
  const normalized = normalizeHandle(member.handle ?? "");
  if (!member.account_id || !member.email) {
    return normalized || "user-member";
  }
  if (normalized && !isLegacyEmailDerivedIdentity(member.email, normalized)) {
    return normalized;
  }
  return publicHandleForAccountId(member.account_id);
}

function publicDisplayNameForMember(member: {
  account_id?: string | null | undefined;
  email?: string | null | undefined;
  display_name?: string | null | undefined;
  handle?: string | null | undefined;
}): string {
  const displayName = member.display_name?.trim();
  if (!member.account_id || !member.email) {
    return displayName || publicHandleForMember(member);
  }
  if (displayName && !isLegacyEmailDerivedIdentity(member.email, displayName)) {
    return displayName.slice(0, 120);
  }
  return fallbackDisplayNameForAccountId(member.account_id);
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

function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfterSeconds = result.retryAfterSeconds ?? 60;
  return Response.json(
    { ok: false, error: "rate_limited", retryAfterSeconds },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } }
  );
}

async function enforceRateLimit(env: Env, input: {
  purpose: string;
  key: string;
  keyHint?: string;
  limit: number;
  windowSeconds: number;
  nowMs?: number;
}): Promise<Response | null> {
  const result = await checkRateLimit(env, input);
  return result.ok ? null : rateLimitedResponse(result);
}

async function enforceRateLimits(env: Env, inputs: Array<{
  purpose: string;
  key: string;
  keyHint?: string;
  limit: number;
  windowSeconds: number;
  nowMs?: number;
}>): Promise<Response | null> {
  for (const input of inputs) {
    const response = await enforceRateLimit(env, input);
    if (response) {
      return response;
    }
  }
  return null;
}

async function enforceAuthEmailRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  const nowMs = Date.now();
  const ip = requestIp(request);
  return enforceRateLimits(env, [
    {
      purpose: "thane_cli_auth_email:email",
      key: email,
      keyHint: email,
      limit: 5,
      windowSeconds: 60 * 60,
      nowMs
    },
    {
      purpose: "thane_cli_auth_email:ip",
      key: ip,
      ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
      limit: 30,
      windowSeconds: 60 * 60,
      nowMs
    }
  ]);
}

async function enforceAuthCodeVerifyRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  const nowMs = Date.now();
  const ip = requestIp(request);
  return enforceRateLimits(env, [
    {
      purpose: "thane_cli_auth_code_verify:email",
      key: email,
      keyHint: email,
      limit: 10,
      windowSeconds: 10 * 60,
      nowMs
    },
    {
      purpose: "thane_cli_auth_code_verify:ip",
      key: ip,
      ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
      limit: 60,
      windowSeconds: 10 * 60,
      nowMs
    }
  ]);
}

async function enforceMfaSetupRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  const nowMs = Date.now();
  const ip = requestIp(request);
  return enforceRateLimits(env, [
    {
      purpose: "thane_cli_mfa_setup:email",
      key: email,
      keyHint: email,
      limit: 5,
      windowSeconds: 60 * 60,
      nowMs
    },
    {
      purpose: "thane_cli_mfa_setup:ip",
      key: ip,
      ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
      limit: 20,
      windowSeconds: 60 * 60,
      nowMs
    }
  ]);
}

async function enforceMfaCodeRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  const nowMs = Date.now();
  const ip = requestIp(request);
  return enforceRateLimits(env, [
    {
      purpose: "thane_cli_mfa_code:email",
      key: email,
      keyHint: email,
      limit: 10,
      windowSeconds: 10 * 60,
      nowMs
    },
    {
      purpose: "thane_cli_mfa_code:ip",
      key: ip,
      ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
      limit: 60,
      windowSeconds: 10 * 60,
      nowMs
    }
  ]);
}

async function enforceWorkspaceActionRateLimits(env: Env, input: {
  action: string;
  workspaceId: string;
  memberId: string;
  email?: string | null;
  memberLimit: number;
  workspaceLimit: number;
  windowSeconds: number;
}): Promise<Response | null> {
  const nowMs = Date.now();
  return enforceRateLimits(env, [
    {
      purpose: `thane_cli_${input.action}:member`,
      key: `${input.workspaceId}:${input.memberId}`,
      ...(input.email ? { keyHint: input.email } : {}),
      limit: input.memberLimit,
      windowSeconds: input.windowSeconds,
      nowMs
    },
    {
      purpose: `thane_cli_${input.action}:workspace`,
      key: input.workspaceId,
      keyHint: input.workspaceId,
      limit: input.workspaceLimit,
      windowSeconds: input.windowSeconds,
      nowMs
    }
  ]);
}

async function enforceSyncRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  const nowMs = Date.now();
  const ip = requestIp(request);
  return enforceRateLimits(env, [
    {
      purpose: "thane_cli_sync:email",
      key: email,
      keyHint: email,
      limit: 180,
      windowSeconds: 60,
      nowMs
    },
    {
      purpose: "thane_cli_sync:ip",
      key: ip,
      ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
      limit: 600,
      windowSeconds: 60,
      nowMs
    }
  ]);
}

async function enforceAuthenticatedActionRateLimits(request: Request, env: Env, input: {
  action: string;
  email: string;
  emailLimit: number;
  ipLimit: number;
  windowSeconds: number;
}): Promise<Response | null> {
  const nowMs = Date.now();
  const ip = requestIp(request);
  return enforceRateLimits(env, [
    {
      purpose: `thane_cli_${input.action}:email`,
      key: input.email,
      keyHint: input.email,
      limit: input.emailLimit,
      windowSeconds: input.windowSeconds,
      nowMs
    },
    {
      purpose: `thane_cli_${input.action}:ip`,
      key: ip,
      ...(ip === "unknown" ? { keyHint: "unknown" } : {}),
      limit: input.ipLimit,
      windowSeconds: input.windowSeconds,
      nowMs
    }
  ]);
}

function makeTotpSecret(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");
}

function renderTerminalQr(qr: QRCode.QRCode): string {
  const quietZone = 1;
  const size = qr.modules.size;
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < size && y < size && qr.modules.get(y, x) === 1;
  const lines: string[] = [];
  for (let y = -quietZone; y < size + quietZone; y += 2) {
    let line = "";
    for (let x = -quietZone; x < size + quietZone; x += 1) {
      const top = isDark(x, y);
      const bottom = isDark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

async function mfaSetupQrCodes(otpauthUrl: string): Promise<MfaSetupQrCodes> {
  const qrOptions = { errorCorrectionLevel: "L" } satisfies QRCode.QRCodeOptions;
  const qrSvg = await QRCode.toString(otpauthUrl, {
    ...qrOptions,
    type: "svg",
    margin: 2,
    scale: 5,
    color: {
      dark: "#0a0f0cff",
      light: "#ffffffff"
    }
  });
  return {
    qrSvg,
    qrTerminal: renderTerminalQr(QRCode.create(otpauthUrl, qrOptions))
  };
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

function billingLinkSecret(env: Env): string {
  const configured = env.BILLING_LINK_SIGNING_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (env.BUILD_ENV === "production") {
    throw new Error("BILLING_LINK_SIGNING_SECRET is required in production.");
  }
  return "thane-local-dev-billing-link-secret";
}

async function signBillingLinkToken(env: Env, payload: { organizationId: string; workspaceId: string; planTier: "cli_team"; iat: number; exp: number }): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(await hmacSha256(encodedPayload, billingLinkSecret(env)));
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
  const accountId = await accountIdForEmail(input.email);
  const savedDisplayName = input.displayName?.trim() || (await profileDisplayNameForEmail(env, input.email));
  const displayName = savedDisplayName || fallbackDisplayNameForAccountId(accountId);
  return {
    id: accountId,
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

async function accountProfileDisplayNameForEmail(env: Env, email: string): Promise<string | null> {
  try {
    const row = await env.DB
      .prepare("SELECT display_name FROM thane_cli_account_profiles WHERE email = ? LIMIT 1")
      .bind(email)
      .first<{ display_name?: string | null }>();
    const displayName = row?.display_name?.trim() || null;
    return displayName && !isLegacyEmailDerivedIdentity(email, displayName) ? displayName : null;
  } catch (error) {
    if (String(error).toLowerCase().includes("no such table")) {
      return null;
    }
    throw error;
  }
}

async function profileDisplayNameForEmail(env: Env, email: string): Promise<string | null> {
  const accountDisplayName = await accountProfileDisplayNameForEmail(env, email);
  if (accountDisplayName) {
    return accountDisplayName;
  }
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
    const displayName = row?.display_name?.trim() || null;
    return displayName && !isLegacyEmailDerivedIdentity(email, displayName) ? displayName : null;
  } catch (error) {
    if (String(error).toLowerCase().includes("no such table")) {
      return null;
    }
    throw error;
  }
}

async function setAccountProfileDisplayName(env: Env, email: string, displayName: string): Promise<void> {
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_account_profiles (email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`
    )
    .bind(email, displayName, now, now)
    .run();
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

function workspaceEventsObject(env: Env, workspaceId: string): DurableObjectStub | null {
  if (!env.THANE_CHAT_EVENTS) {
    return null;
  }
  return env.THANE_CHAT_EVENTS.get(env.THANE_CHAT_EVENTS.idFromName(workspaceId));
}

async function broadcastThaneChatEvent(env: Env, event: ThaneChatPushEvent): Promise<void> {
  const stub = workspaceEventsObject(env, event.workspaceId);
  if (!stub) {
    return;
  }
  await stub.fetch("https://thane-chat-events.local/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  });
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

function appendInviteeEmailToUrl(url: string, inviteeEmail?: string | null): string {
  if (!inviteeEmail) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("email", inviteeEmail);
    return parsed.toString();
  } catch (_error) {
    return url;
  }
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
  invitee_email?: string | null;
} | null> {
  try {
    return await env.DB
      .prepare(
        `SELECT id, workspace_id, workspace_slug, workspace_name, role, expires_at, revoked_at, accepted_count, max_uses, invitee_email
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
        invitee_email?: string | null;
      }>();
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("no such column") && message.includes("invitee_email")) {
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
    }
    if (message.includes("no such table")) {
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
    displayName: await profileDisplayNameForEmail(env, input.email),
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
  const handle = publicHandleForAccountId(accountId);
  const legacyHandle = normalizeHandleFromEmail(input.email);
  const legacyDisplayName = input.email.split("@")[0]?.trim() || legacyHandle;
  const displayName = input.displayName?.trim() || fallbackDisplayNameForAccountId(accountId);
  const now = nowIso();
  const existingMember = await env.DB
    .prepare("SELECT id, joined_at FROM thane_cli_workspace_members WHERE workspace_id = ? AND email = ? LIMIT 1")
    .bind(input.workspaceId, input.email)
    .first<{ id?: string; joined_at?: string | null }>();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_workspace_members (
         id, workspace_id, account_id, email, display_name, handle, role, joined_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET
         account_id = excluded.account_id,
         display_name = CASE
           WHEN thane_cli_workspace_members.display_name = ? THEN excluded.display_name
           ELSE COALESCE(NULLIF(thane_cli_workspace_members.display_name, ''), excluded.display_name)
         END,
         handle = CASE
           WHEN thane_cli_workspace_members.handle = ? THEN excluded.handle
           ELSE COALESCE(NULLIF(thane_cli_workspace_members.handle, ''), excluded.handle)
         END,
         role = CASE
           WHEN thane_cli_workspace_members.role = 'owner' THEN 'owner'
           ELSE excluded.role
         END,
         updated_at = excluded.updated_at`
    )
    .bind(makeId("tcm"), input.workspaceId, accountId, input.email, displayName, handle, input.role, now, now, legacyDisplayName, legacyHandle)
    .run();
  const row = await env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle, role, joined_at
       FROM thane_cli_workspace_members
       WHERE workspace_id = ? AND email = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.email)
    .first<{ id?: string; account_id?: string; email?: string; display_name?: string | null; handle?: string; role?: string; joined_at?: string | null }>();
  if (!row?.id || !row.account_id || !row.email || !row.handle || !row.role) {
    throw new Error("member_upsert_failed");
  }
  if (!existingMember?.id && row.email !== "thane@askthane.com") {
    await recordThaneCliWorkspaceJoinMessage(env, {
      workspaceId: input.workspaceId,
      memberId: row.id,
      displayName: publicDisplayNameForMember({ account_id: row.account_id, email: row.email, display_name: row.display_name, handle: row.handle }),
      joinedAt: row.joined_at ?? now
    });
  }
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    handle: publicHandleForMember({ account_id: row.account_id, email: row.email, handle: row.handle }),
    displayName: publicDisplayNameForMember({ account_id: row.account_id, email: row.email, display_name: row.display_name, handle: row.handle }),
    role: row.role
  };
}

async function ensureThaneCliChannel(
  env: Env,
  workspaceId: string,
  name: string,
  topic?: string | null,
  visibility: "public" | "private" = "public"
): Promise<{
  id: string;
  workspaceId: string;
  name: string;
  kind: "channel";
  visibility: "public" | "private";
  topic?: string | null;
  createdAt: string;
}> {
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
      `SELECT id, workspace_id, name, kind, visibility, topic, created_at
       FROM thane_cli_channels
       WHERE workspace_id = ? AND name = ?
       LIMIT 1`
    )
    .bind(workspaceId, name)
    .first<{
      id?: string;
      workspace_id?: string;
      name?: string;
      kind?: "channel";
      visibility?: "public" | "private";
      topic?: string | null;
      created_at?: string;
    }>();
  if (!row?.id || !row.workspace_id || !row.name || row.kind !== "channel" || !row.visibility || !row.created_at) {
    throw new Error("channel_upsert_failed");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    visibility: row.visibility,
    ...(row.topic ? { topic: row.topic } : {}),
    createdAt: row.created_at
  };
}

function workspaceJoinMessageId(memberId: string): string {
  return `tjoin_${memberId}`;
}

function workspaceJoinMessageText(displayName: string): string {
  return `${displayName.trim() || "A member"} joined the workspace.`;
}

async function recordThaneCliWorkspaceJoinMessage(env: Env, input: {
  workspaceId: string;
  memberId: string;
  displayName: string;
  joinedAt: string;
}): Promise<void> {
  const messageId = workspaceJoinMessageId(input.memberId);
  const existing = await env.DB
    .prepare("SELECT id FROM thane_cli_chat_messages WHERE id = ? LIMIT 1")
    .bind(messageId)
    .first<{ id?: string }>();
  if (existing?.id) {
    return;
  }
  const channel = await ensureThaneCliChannel(env, input.workspaceId, "general", "Community-wide conversation");
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_chat_messages (
         id, workspace_id, channel_id, author_member_id, text, source, thread_root_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'chat', NULL, ?, ?)`
    )
    .bind(messageId, input.workspaceId, channel.id, input.memberId, workspaceJoinMessageText(input.displayName), input.joinedAt, input.joinedAt)
    .run();
  await broadcastThaneChatEvent(env, {
    type: "message_created",
    workspaceId: input.workspaceId,
    channelId: channel.id,
    messageId,
    occurredAt: input.joinedAt
  }).catch((error) => {
    console.warn("thane_chat_join_event_broadcast_failed", {
      workspaceId: input.workspaceId,
      reason: error instanceof Error ? error.message : String(error)
    });
  });
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

async function isThaneCliWorkspaceBanned(env: Env, workspaceId: string, email: string): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare("SELECT id FROM thane_cli_workspace_bans WHERE workspace_id = ? AND email = ? LIMIT 1")
      .bind(workspaceId, email)
      .first<{ id?: string }>();
    return Boolean(row?.id);
  } catch (error) {
    if (String(error).toLowerCase().includes("no such table")) {
      return false;
    }
    throw error;
  }
}

function isThaneCliWorkspaceAdmin(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

async function countThaneCliWorkspaceOwners(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM thane_cli_workspace_members WHERE workspace_id = ? AND role = 'owner'")
    .bind(workspaceId)
    .first<{ count?: number }>();
  return Number(row?.count ?? 0);
}

async function resolveThaneCliWorkspaceMember(env: Env, input: {
  workspaceId: string;
  target: string;
}): Promise<{ id: string; account_id: string; email: string; display_name: string | null; handle: string; role: string } | null> {
  const target = input.target.trim();
  if (!target) {
    return null;
  }
  const normalizedHandle = normalizeHandle(target) || "";
  return env.DB
    .prepare(
      `SELECT id, account_id, email, display_name, handle, role
       FROM thane_cli_workspace_members
       WHERE workspace_id = ?
         AND (id = ? OR email = ? OR handle = ?)
       LIMIT 1`
    )
    .bind(input.workspaceId, target, normalizeEmail(target), normalizedHandle)
    .first<{ id: string; account_id: string; email: string; display_name: string | null; handle: string; role: string }>();
}

async function resolveThaneCliChannel(env: Env, input: {
  workspaceId: string;
  channelId?: string | null;
  channelName?: string | null;
}): Promise<{ id: string; name: string; kind: ThaneCliConversationKind; visibility: ThaneCliConversationVisibility } | null> {
  if (input.channelId) {
    return env.DB
      .prepare("SELECT id, name, kind, visibility FROM thane_cli_channels WHERE workspace_id = ? AND id = ? LIMIT 1")
      .bind(input.workspaceId, input.channelId)
      .first<{ id: string; name: string; kind: ThaneCliConversationKind; visibility: ThaneCliConversationVisibility }>();
  }
  if (input.channelName) {
    return env.DB
      .prepare("SELECT id, name, kind, visibility FROM thane_cli_channels WHERE workspace_id = ? AND name = ? LIMIT 1")
      .bind(input.workspaceId, input.channelName)
      .first<{ id: string; name: string; kind: ThaneCliConversationKind; visibility: ThaneCliConversationVisibility }>();
  }
  return null;
}

async function canThaneCliMemberUseChannel(env: Env, input: {
  channelId: string;
  visibility: ThaneCliConversationVisibility;
  memberId: string;
}): Promise<boolean> {
  const membership = await env.DB
    .prepare("SELECT left_at FROM thane_cli_channel_members WHERE channel_id = ? AND member_id = ? LIMIT 1")
    .bind(input.channelId, input.memberId)
    .first<{ left_at?: string | null }>();
  if (input.visibility === "public") {
    return !membership?.left_at;
  }
  return Boolean(membership && !membership.left_at);
}

function renderAskThaneIntegration(row: ThaneCliAskThaneIntegrationRow | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    workspaceId: row.workspace_id,
    enabled: row.enabled === 1,
    botUserId: row.bot_member_id ?? "thane",
    linkedAccountEmail: row.linked_account_email ?? "thane@askthane.com",
    provider: "thane_cli",
    externalUserId: row.linked_account_email ?? "thane@askthane.com",
    connectedAt: row.connected_at,
    ...(row.last_event_at ? { lastEventAt: row.last_event_at } : {})
  };
}

async function askThaneIntegrationForWorkspace(env: Env, workspaceId: string): Promise<ThaneCliAskThaneIntegrationRow | null> {
  try {
    const bound = env.DB
      .prepare(
        `SELECT workspace_id, enabled, bot_member_id, linked_account_email, connected_at, updated_at, last_event_at
         FROM thane_cli_ask_thane_integrations
         WHERE workspace_id = ?
         LIMIT 1`
      )
      .bind(workspaceId);
    if (typeof bound.first !== "function") {
      return null;
    }
    return await bound.first<ThaneCliAskThaneIntegrationRow>();
  } catch (error) {
    if (String(error).toLowerCase().includes("no such table")) {
      return null;
    }
    throw error;
  }
}

async function ensureAskThaneMember(env: Env, workspaceId: string): Promise<{ id: string; accountId: string; email: string; handle: string; displayName: string; role: string }> {
  return ensureThaneCliMember(env, {
    workspaceId,
    email: "thane@askthane.com",
    displayName: "Ask Thane",
    role: "member"
  });
}

function isThaneCliTeam(planTier: string | null | undefined): boolean {
  return planTier === "cli_team";
}

function thaneCliLimitReachedResponse(error: "thane_chat_member_limit_reached" | "thane_chat_private_channel_limit_reached", limit: number): Response {
  return Response.json(
    {
      ok: false,
      error,
      limit,
      upgrade: "thane billing checkout"
    },
    { status: 402 }
  );
}

async function thaneCliWorkspacePlanTier(env: Env, workspaceId: string): Promise<ThaneCliPlanTier> {
  const row = await env.DB
    .prepare("SELECT plan_tier FROM thane_cli_workspaces WHERE id = ? LIMIT 1")
    .bind(workspaceId)
    .first<{ plan_tier?: string | null }>();
  return row?.plan_tier === "cli_team" ? "cli_team" : "free";
}

async function countThaneCliWorkspaceMembers(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM thane_cli_workspace_members WHERE workspace_id = ?")
    .bind(workspaceId)
    .first<{ count?: number | string | null }>();
  return Number(row?.count ?? 0);
}

async function countThaneCliPrivateChannels(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM thane_cli_channels WHERE workspace_id = ? AND kind = 'channel' AND visibility = 'private'")
    .bind(workspaceId)
    .first<{ count?: number | string | null }>();
  return Number(row?.count ?? 0);
}

async function ensureNativeAgentRefs(
  env: Env,
  input: {
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    channelId: string;
    channelName: string;
    channelKind: ThaneCliConversationKind;
    channelVisibility: ThaneCliConversationVisibility;
    memberId: string;
    memberHandle: string;
    memberDisplayName: string | null;
    memberEmail: string;
    memberRole: string;
  }
): Promise<NativeAgentRefs> {
  const now = nowIso();
  const organizationId = input.workspaceId;
  await env.DB
    .prepare(
      `INSERT INTO organizations (id, slug, name, plan_tier, created_at, updated_at)
       VALUES (?, ?, ?, (SELECT plan_tier FROM thane_cli_workspaces WHERE id = ?), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         plan_tier = COALESCE((SELECT plan_tier FROM thane_cli_workspaces WHERE id = ?), organizations.plan_tier),
         updated_at = excluded.updated_at`
    )
    .bind(organizationId, input.workspaceSlug, input.workspaceName, input.workspaceId, now, now, input.workspaceId)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO workspaces (id, organization_id, platform, external_workspace_id, name, plan_tier, created_at, updated_at)
       VALUES (?, ?, 'thane_cli', ?, ?, (SELECT plan_tier FROM thane_cli_workspaces WHERE id = ?), ?, ?)
       ON CONFLICT(platform, external_workspace_id) DO UPDATE SET
         name = excluded.name,
         plan_tier = COALESCE((SELECT plan_tier FROM thane_cli_workspaces WHERE id = ?), workspaces.plan_tier),
         updated_at = excluded.updated_at`
    )
    .bind(input.workspaceId, organizationId, input.workspaceId, input.workspaceName, input.workspaceId, now, now, input.workspaceId)
    .run();
  const userId = `usr_thane_${input.memberId}`;
  await env.DB
    .prepare(
      `INSERT INTO users (id, organization_id, workspace_id, platform, external_user_id, display_name, email, role, created_at, updated_at)
       VALUES (?, ?, ?, 'thane_cli', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, platform, external_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         email = excluded.email,
         role = excluded.role,
         updated_at = excluded.updated_at`
    )
    .bind(
      userId,
      organizationId,
      input.workspaceId,
      input.memberHandle,
      input.memberDisplayName || input.memberHandle,
      input.memberEmail,
      input.memberRole,
      now,
      now
    )
    .run();
  const conversationSourceId = `conv_thane_${input.channelId}`;
  const conversationKind =
    input.channelKind === "dm" ? "dm" : input.channelVisibility === "private" ? "private_channel" : "public_channel";
  const isPublic = conversationKind === "public_channel" ? 1 : 0;
  await env.DB
    .prepare(
      `INSERT INTO conversation_sources (
         id, organization_id, workspace_id, provider, provider_conversation_id,
         conversation_kind, is_public, created_at, updated_at
       ) VALUES (?, ?, ?, 'thane_cli', ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, provider, provider_conversation_id) DO UPDATE SET
         conversation_kind = excluded.conversation_kind,
         is_public = excluded.is_public,
         updated_at = excluded.updated_at`
    )
    .bind(conversationSourceId, organizationId, input.workspaceId, input.channelId, conversationKind, isPublic, now, now)
    .run();
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO conversation_memberships (
         id, organization_id, workspace_id, conversation_source_id, user_id, role, is_active, synced_at
       ) VALUES (?, ?, ?, ?, ?, 'member', 1, ?)`
    )
    .bind(makeId("cmem"), organizationId, input.workspaceId, conversationSourceId, userId, now)
    .run();
  return { organizationId, workspaceId: input.workspaceId, userId, conversationSourceId };
}

async function nativeAiGate(env: Env, workspaceId: string): Promise<{ ok: boolean; reason?: string }> {
  const planTier = await thaneCliWorkspacePlanTier(env, workspaceId);
  if (isThaneCliTeam(planTier)) {
    return { ok: true };
  }
  const memberCount = await countThaneCliWorkspaceMembers(env, workspaceId);
  if (memberCount > THANE_CLI_FREE_LIMITS.members) {
    return { ok: false, reason: "free_member_limit_exceeded" };
  }
  const cap = Number(env.FREE_TIER_MONTHLY_AI_CAP_USD ?? "10");
  if (Number.isFinite(cap) && cap > 0) {
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const row = await env.DB
      .prepare(
        `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
         FROM llm_usage_events
         WHERE workspace_id = ?
           AND created_at >= ?`
      )
      .bind(workspaceId, since.toISOString())
      .first<{ total?: number | string | null }>();
    if (Number(row?.total ?? 0) >= cap) {
      return { ok: false, reason: "free_ai_spend_limit_exceeded" };
    }
  }
  return { ok: true };
}

async function inferNativeTasksFromMessage(
  env: Env,
  input: {
    refs: NativeAgentRefs;
    text: string;
    messageId: string;
    channelId: string;
    authorHandle: string;
    authorDisplayName: string | null;
    occurredAt: string;
  }
): Promise<number> {
  const gate = await nativeAiGate(env, input.refs.workspaceId);
  if (!gate.ok || !env.OPENAI_API_KEY) {
    return 0;
  }
  const llm = createLlmClient({
    provider: env.DEFAULT_LLM_PROVIDER ?? "openai",
    model: env.DEFAULT_LLM_MODEL ?? "gpt-4.1-mini",
    ...(env.OPENAI_API_KEY ? { openAiApiKey: env.OPENAI_API_KEY } : {}),
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {})
  });
  const event: MessageEvent = {
    workspaceId: input.refs.workspaceId,
    channelId: input.refs.conversationSourceId,
    messageId: input.messageId,
    text: input.text,
    author: {
      platform: "thane_cli",
      platformUserId: input.authorHandle,
      ...(input.authorDisplayName ? { displayName: input.authorDisplayName } : {})
    },
    occurredAt: input.occurredAt
  };
  const repo = new D1TaskRepository(env.DB);
  const tasks = await ingestMessageForTasks(event, { llm, tasks: repo });
  return tasks.length;
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
  const webInviteLink = appendInviteeEmailToUrl(`${webInviteBaseUrl(env)}/${encodeURIComponent(token)}`, row!.invitee_email);
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
      `Accept in the web app:\n${input.url}\n\n` +
      `Prefer the terminal app?\nnpm install -g @ask-thane/thane-cli\nthane init\nthane invite-link accept ${input.cliUrl ?? input.url}\n\n` +
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
  const rateLimited = await enforceAuthCodeVerifyRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
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

  const verifiedDisplayName =
    typeof authRow.display_name === "string" && authRow.display_name.trim()
      ? authRow.display_name.trim()
      : null;
  if (verifiedDisplayName) {
    await setAccountProfileDisplayName(env, email, verifiedDisplayName);
  }
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
    account: await buildAccount(env, { email, displayName: verifiedDisplayName })
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
  const rateLimited = await enforceMfaCodeRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
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
  const rateLimited = await enforceMfaSetupRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
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
  const otpauthUrl = `otpauth://totp/Thane%20Chat:${encodeURIComponent(email)}?secret=${secret}&issuer=Thane%20Chat&algorithm=SHA1&digits=6&period=30`;
  return Response.json({
    ok: true,
    factorId,
    secret,
    otpauthUrl,
    ...(await mfaSetupQrCodes(otpauthUrl))
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
  const rateLimited = await enforceMfaCodeRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
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
  const rateLimited = await enforceMfaCodeRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
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
  const handle = normalizeHandle(payload?.handle);
  if (!displayName && !handle) {
    return Response.json({ ok: false, error: "profile_update_required" }, { status: 400 });
  }
  const rateLimited = await enforceAuthenticatedActionRateLimits(request, env, {
    action: "profile_update",
    email,
    emailLimit: 30,
    ipLimit: 300,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const scope = typeof payload?.scope === "string" ? payload.scope.trim().toLowerCase() : "";
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim().slice(0, 120) : null;
  if (scope === "workspace" || workspaceId || handle) {
    if (!workspaceId) {
      return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
    }
    const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
    if (!member) {
      return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
    }
    if (handle) {
      const existingRows = await env.DB
        .prepare(
          `SELECT id, account_id, email, handle
           FROM thane_cli_workspace_members
           WHERE workspace_id = ? AND email != ?`
        )
        .bind(workspaceId, email)
        .all<{ id: string; account_id: string; email: string; handle: string | null }>();
      const existing = (existingRows.results ?? []).find((candidate) => publicHandleForMember(candidate) === handle);
      if (existing) {
        return Response.json({ ok: false, error: "handle_taken" }, { status: 409 });
      }
    }
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (displayName) {
      assignments.push("display_name = ?");
      values.push(displayName);
    }
    if (handle) {
      assignments.push("handle = ?");
      values.push(handle);
    }
    assignments.push("updated_at = ?");
    values.push(nowIso(), workspaceId, email);
    await env.DB
      .prepare(`UPDATE thane_cli_workspace_members SET ${assignments.join(", ")} WHERE workspace_id = ? AND email = ?`)
      .bind(...values)
      .run();
    return Response.json({
      ok: true,
      scope: "workspace",
      workspaceId,
      account: await buildAccount(env, { email }),
      ...(displayName ? { displayName, workspaceDisplayName: displayName } : {}),
      ...(handle ? { handle, workspaceHandle: handle } : {})
    });
  }
  if (!displayName) {
    return Response.json({ ok: false, error: "display_name_required" }, { status: 400 });
  }
  if (scope === "account") {
    await setAccountProfileDisplayName(env, email, displayName);
    return Response.json({
      ok: true,
      scope: "account",
      account: await buildAccount(env, { email, displayName }),
      displayName,
      accountDisplayName: displayName
    });
  }
  await env.DB
    .prepare("UPDATE thane_cli_workspace_members SET display_name = ?, updated_at = ? WHERE email = ?")
    .bind(displayName, nowIso(), email)
    .run();
  await setAccountProfileDisplayName(env, email, displayName);
  return Response.json({
    ok: true,
    scope: "global",
    account: await buildAccount(env, { email, displayName }),
    displayName,
    accountDisplayName: displayName,
    workspaceDisplayName: displayName
  });
}

async function handleThaneCliWorkspaceEnsure(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliWorkspaceEnsurePayload>(request);
  const requestedWorkspaceName = normalizeWorkspaceName(payload?.workspaceName);
  const workspaceSlug = normalizeWorkspaceSlug(payload?.workspaceSlug) ?? workspaceSlugFromName(requestedWorkspaceName);
  const workspaceName = requestedWorkspaceName ?? workspaceSlug;
  if (!workspaceSlug || !workspaceName) {
    return Response.json({ ok: false, error: "workspace_name_required" }, { status: 400 });
  }
  const rateLimited = await enforceAuthenticatedActionRateLimits(request, env, {
    action: "workspace_ensure",
    email,
    emailLimit: 20,
    ipLimit: 100,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
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
  const rateLimited = await enforceSyncRateLimits(request, env, email);
  if (rateLimited) {
    return rateLimited;
  }
  const url = new URL(request.url);
  const requestedWorkspaceId = url.searchParams.get("workspaceId")?.trim() || null;
  const workspaceRows = await env.DB
    .prepare(
      `SELECT w.id, w.workspace_slug, w.workspace_name, w.ascii_art, w.plan_tier, w.created_at, w.updated_at, m.role
       FROM thane_cli_workspace_members m
       JOIN thane_cli_workspaces w ON w.id = m.workspace_id
       WHERE m.email = ? AND w.status = 'active'
       ORDER BY w.workspace_slug`
    )
    .bind(email)
    .all<{
      id: string;
      workspace_slug: string;
      workspace_name: string | null;
      ascii_art: string | null;
      plan_tier: ThaneCliPlanTier | string | null;
      created_at: string;
      updated_at: string;
      role: string;
    }>();

  const workspaces = (workspaceRows.results ?? []).map((row) => ({
    id: row.id,
    slug: row.workspace_slug,
    name: row.workspace_name || row.workspace_slug,
    createdAt: row.created_at,
    ...(row.ascii_art ? { asciiArt: row.ascii_art } : {})
  }));
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === requestedWorkspaceId || workspace.slug === requestedWorkspaceId) ?? workspaces[0];
  const activeWorkspaceRow = (workspaceRows.results ?? []).find((row) => row.id === activeWorkspace?.id);
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
      messages: [],
      askThaneIntegrations: [],
      billingPlans: []
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
  const currentMember = members.find((member) => member.email === email);
  const canSeeMemberEmails = isThaneCliWorkspaceAdmin(currentMember?.role);
  const users = members.map((member) => ({
    id: member.id,
    workspaceId: activeWorkspace.id,
    accountId: member.account_id,
    handle: publicHandleForMember(member),
    displayName: publicDisplayNameForMember(member),
    ...(canSeeMemberEmails || member.email === email ? { email: member.email } : {})
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
  const channelIds = (channelRows.results ?? []).map((channel) => channel.id);
  const channelMembershipsByChannel = new Map<string, Array<{ memberId: string; leftAt: string | null }>>();
  if (channelIds.length > 0) {
    const channelMembershipRows = await env.DB
      .prepare(
        `SELECT channel_id, member_id, left_at
         FROM thane_cli_channel_members
         WHERE channel_id IN (${channelIds.map(() => "?").join(", ")})`
      )
      .bind(...channelIds)
      .all<{ channel_id: string; member_id: string; left_at: string | null }>();
    for (const membership of channelMembershipRows.results ?? []) {
      const memberships = channelMembershipsByChannel.get(membership.channel_id) ?? [];
      memberships.push({ memberId: membership.member_id, leftAt: membership.left_at ?? null });
      channelMembershipsByChannel.set(membership.channel_id, memberships);
    }
  }
  const channels = (channelRows.results ?? []).flatMap((channel) => {
    const memberships = channelMembershipsByChannel.get(channel.id) ?? [];
    const leftMemberIds = new Set(memberships.filter((membership) => membership.leftAt).map((membership) => membership.memberId));
    const activeMembershipIds = memberships.filter((membership) => !membership.leftAt).map((membership) => membership.memberId);
    const channelMemberIds = channel.visibility === "public"
      ? memberIds.filter((memberId) => !leftMemberIds.has(memberId))
      : activeMembershipIds;
    if (currentMember && !channelMemberIds.includes(currentMember.id)) {
      return [];
    }
    return [{
    id: channel.id,
    workspaceId: channel.workspace_id,
    name: channel.name,
    kind: channel.kind,
    visibility: channel.visibility,
    memberIds: channelMemberIds,
    ...(channel.topic ? { topic: channel.topic } : {}),
    createdAt: channel.created_at
    }];
  });

  const messageRows = await env.DB
    .prepare(
      `SELECT msg.id, msg.workspace_id, msg.channel_id, msg.author_member_id, msg.text, msg.source, msg.thread_root_id, msg.created_at
       FROM thane_cli_chat_messages msg
       JOIN thane_cli_channels c ON c.id = msg.channel_id
       WHERE msg.workspace_id = ?
         AND msg.channel_id IN (${channels.length > 0 ? channels.map(() => "?").join(", ") : "NULL"})
       ORDER BY msg.created_at DESC
       LIMIT 300`
    )
    .bind(activeWorkspace.id, ...channels.map((channel) => channel.id))
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
        `SELECT reaction.message_id, reaction.emoji, reaction.created_at, member.account_id, member.email, member.handle
         FROM thane_cli_message_reactions reaction
         JOIN thane_cli_workspace_members member ON member.id = reaction.member_id
         WHERE reaction.message_id IN (${messageIds.map(() => "?").join(", ")})
         ORDER BY reaction.created_at ASC`
      )
      .bind(...messageIds)
      .all<{ message_id: string; emoji: string; created_at: string; account_id: string; email: string; handle: string | null }>();
    for (const reaction of reactionRows.results ?? []) {
      const reactions = reactionsByMessage.get(reaction.message_id) ?? [];
      reactions.push({
        emoji: reaction.emoji,
        by: publicHandleForMember(reaction),
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
  const askThaneIntegration = renderAskThaneIntegration(await askThaneIntegrationForWorkspace(env, activeWorkspace.id));

  return Response.json({
    ok: true,
    account,
    activeWorkspaceId: activeWorkspace.id,
    workspaces,
    workspaceMembers,
    users,
    channels,
    messages,
    askThaneIntegrations: askThaneIntegration ? [askThaneIntegration] : [],
    billingPlans: [
      {
        workspaceId: activeWorkspace.id,
        planTier: activeWorkspaceRow?.plan_tier === "cli_team" ? "cli_team" : "free",
        status: "active",
        updatedAt: activeWorkspaceRow?.updated_at ?? activeWorkspace.createdAt
      }
    ]
  });
}

async function handleThaneCliEvents(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const authToken = url.searchParams.get("authToken");
  const email = authToken
    ? (await verifyToken(env, authToken, "auth"))?.email ?? null
    : await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "events_connect",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 60,
    workspaceLimit: 600,
    windowSeconds: 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const stub = workspaceEventsObject(env, workspaceId);
  if (!stub) {
    return Response.json({ ok: false, error: "events_unavailable" }, { status: 503 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return stub.fetch("https://thane-chat-events.local/stream", { method: "GET" });
  }
  try {
    return await stub.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (url.searchParams.get("debug") === "1") {
      return Response.json({ ok: false, error: "events_upgrade_failed", message }, { status: 500 });
    }
    console.error("Thane Chat events upgrade failed", message);
    return Response.json({ ok: false, error: "events_upgrade_failed" }, { status: 500 });
  }
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
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "channel_create",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 30,
    workspaceLimit: 200,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  if (payload?.private) {
    const existingChannel = await env.DB
      .prepare("SELECT id, visibility FROM thane_cli_channels WHERE workspace_id = ? AND name = ? LIMIT 1")
      .bind(workspaceId, name)
      .first<{ id?: string; visibility?: "public" | "private" }>();
    if (existingChannel?.visibility !== "private") {
      const planTier = await thaneCliWorkspacePlanTier(env, workspaceId);
      const privateChannelCount = await countThaneCliPrivateChannels(env, workspaceId);
      if (!isThaneCliTeam(planTier) && privateChannelCount >= THANE_CLI_FREE_LIMITS.privateChannels) {
        return thaneCliLimitReachedResponse("thane_chat_private_channel_limit_reached", THANE_CLI_FREE_LIMITS.privateChannels);
      }
    }
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

async function handleThaneCliChannelJoin(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliChannelMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const channelId = typeof payload?.channelId === "string" && payload.channelId.trim() ? payload.channelId.trim() : null;
  const channelName = normalizeChannelName(payload?.channelName);
  if (!workspaceId || (!channelId && !channelName)) {
    return Response.json({ ok: false, error: "workspace_id_and_channel_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "channel_join",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 120,
    workspaceLimit: 1_000,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const channel = await resolveThaneCliChannel(env, { workspaceId, channelId, channelName });
  if (!channel?.id || channel.kind !== "channel") {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  if (channel.visibility === "private" && !isThaneCliWorkspaceAdmin(member.role)) {
    const existing = await env.DB
      .prepare("SELECT id FROM thane_cli_channel_members WHERE channel_id = ? AND member_id = ? AND left_at IS NULL LIMIT 1")
      .bind(channel.id, member.id)
      .first<{ id?: string }>();
    if (!existing?.id) {
      return Response.json({ ok: false, error: "private_channel_invite_required" }, { status: 403 });
    }
  }
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_channel_members (id, channel_id, member_id, joined_at, left_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(channel_id, member_id) DO UPDATE SET
         left_at = NULL,
         joined_at = excluded.joined_at`
    )
    .bind(makeId("tccm"), channel.id, member.id, now)
    .run();
  return Response.json({ ok: true, channelId: channel.id, joined: true });
}

async function handleThaneCliChannelLeave(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliChannelMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const channelId = typeof payload?.channelId === "string" && payload.channelId.trim() ? payload.channelId.trim() : null;
  const channelName = normalizeChannelName(payload?.channelName);
  if (!workspaceId || (!channelId && !channelName)) {
    return Response.json({ ok: false, error: "workspace_id_and_channel_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "channel_leave",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 120,
    workspaceLimit: 1_000,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const channel = await resolveThaneCliChannel(env, { workspaceId, channelId, channelName });
  if (!channel?.id || channel.kind !== "channel") {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_channel_members (id, channel_id, member_id, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, member_id) DO UPDATE SET
         left_at = excluded.left_at`
    )
    .bind(makeId("tccm"), channel.id, member.id, now, now)
    .run();
  return Response.json({ ok: true, channelId: channel.id, left: true });
}

async function handleThaneCliChannelMemberAdd(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliChannelMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const channelId = typeof payload?.channelId === "string" && payload.channelId.trim() ? payload.channelId.trim() : null;
  const channelName = normalizeChannelName(payload?.channelName);
  const target = typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null;
  if (!workspaceId || (!channelId && !channelName) || !target) {
    return Response.json({ ok: false, error: "workspace_id_channel_and_target_required" }, { status: 400 });
  }
  const actor = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!actor) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "channel_member_add",
    workspaceId,
    memberId: actor.id,
    email: actor.email,
    memberLimit: 60,
    workspaceLimit: 500,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const channel = await resolveThaneCliChannel(env, { workspaceId, channelId, channelName });
  if (!channel?.id || channel.kind !== "channel") {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  const actorCanUseChannel = await canThaneCliMemberUseChannel(env, { channelId: channel.id, visibility: channel.visibility, memberId: actor.id });
  if (!actorCanUseChannel && !isThaneCliWorkspaceAdmin(actor.role)) {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  const targetMember = await resolveThaneCliWorkspaceMember(env, { workspaceId, target });
  if (!targetMember) {
    return Response.json({ ok: false, error: "member_not_found" }, { status: 404 });
  }
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_channel_members (id, channel_id, member_id, joined_at, left_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(channel_id, member_id) DO UPDATE SET
         left_at = NULL,
         joined_at = excluded.joined_at`
    )
    .bind(makeId("tccm"), channel.id, targetMember.id, now)
    .run();
  return Response.json({ ok: true, channelId: channel.id, memberId: targetMember.id, invited: true });
}

async function handleThaneCliChannelMemberRemove(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliChannelMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const channelId = typeof payload?.channelId === "string" && payload.channelId.trim() ? payload.channelId.trim() : null;
  const channelName = normalizeChannelName(payload?.channelName);
  const target = typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null;
  if (!workspaceId || (!channelId && !channelName) || !target) {
    return Response.json({ ok: false, error: "workspace_id_channel_and_target_required" }, { status: 400 });
  }
  const actor = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!actor) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "channel_member_remove",
    workspaceId,
    memberId: actor.id,
    email: actor.email,
    memberLimit: 60,
    workspaceLimit: 500,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  if (!isThaneCliWorkspaceAdmin(actor.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const channel = await resolveThaneCliChannel(env, { workspaceId, channelId, channelName });
  const targetMember = await resolveThaneCliWorkspaceMember(env, { workspaceId, target });
  if (!channel?.id || channel.kind !== "channel") {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  if (!targetMember) {
    return Response.json({ ok: false, error: "member_not_found" }, { status: 404 });
  }
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_channel_members (id, channel_id, member_id, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, member_id) DO UPDATE SET
         left_at = excluded.left_at`
    )
    .bind(makeId("tccm"), channel.id, targetMember.id, now, now)
    .run();
  return Response.json({ ok: true, channelId: channel.id, memberId: targetMember.id, removed: true });
}

async function recentThaneChatContext(env: Env, input: { workspaceId: string; channelId: string; threadRootId?: string | null }): Promise<string> {
  const messageRows = await env.DB
    .prepare(
      `SELECT msg.id, msg.text, msg.created_at, msg.thread_root_id, member.account_id, member.email, member.handle
       FROM thane_cli_chat_messages msg
       JOIN thane_cli_workspace_members member ON member.id = msg.author_member_id
       WHERE msg.workspace_id = ?
         AND msg.channel_id = ?
       ORDER BY msg.created_at DESC
       LIMIT 40`
    )
    .bind(input.workspaceId, input.channelId)
    .all<{ id: string; text: string; created_at: string; thread_root_id: string | null; account_id: string; email: string; handle: string | null }>();
  const rows = (messageRows.results ?? []).reverse();
  const focusedRows = input.threadRootId
    ? rows.filter((row) => row.id === input.threadRootId || row.thread_root_id === input.threadRootId)
    : rows;
  return focusedRows
    .slice(-30)
    .map((row) => `[${row.created_at}] @${publicHandleForMember(row)}: ${row.text}`)
    .join("\n");
}

async function generateNativeAskThaneReply(
  env: Env,
  input: { workspaceName: string; channelName: string; context: string; text: string }
): Promise<{ text: string; model: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } | null> {
  if ((env.DEFAULT_LLM_PROVIDER ?? "openai") !== "openai" || !env.OPENAI_API_KEY) {
    return null;
  }
  const model = env.DEFAULT_LLM_MODEL?.trim() || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are Ask Thane inside Thane Chat, an agent-first chat application. Reply helpfully and concisely in plain text. You can use recent chat context, but do not claim to have actions or tools you do not have. If the user asks you to perform a product action that is not possible from context, say what you can do next."
        },
        {
          role: "user",
          content:
            `Workspace: ${input.workspaceName}\nChannel: #${input.channelName}\n\nRecent context:\n${input.context || "(no recent context)"}\n\nNew message mentioning @thane:\n${input.text}`
        }
      ]
    })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  if (!response.ok) {
    console.warn("native_ask_thane_openai_failed", { status: response.status, reason: payload.error?.message ?? "unknown" });
    return null;
  }
  const text = payload.choices?.[0]?.message?.content?.trim();
  return text ? { text: text.slice(0, 4000), model, ...(payload.usage ? { usage: payload.usage } : {}) } : null;
}

async function recordNativeLlmUsage(
  env: Env,
  input: { organizationId: string; workspaceId: string; model: string; sourceMessageId: string; requestType: string; promptTokens?: number; completionTokens?: number; totalTokens?: number }
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO llm_usage_events (
         id, organization_id, workspace_id, provider, model, prompt_tokens, completion_tokens, total_tokens,
         prompt_cost_usd, completion_cost_usd, total_cost_usd, currency, pricing_version, api_endpoint,
         request_type, source, source_message_id, created_at
       ) VALUES (?, ?, ?, 'openai', ?, ?, ?, ?, NULL, NULL, NULL, 'usd', 'unpriced', 'chat.completions', ?, 'thane_chat', ?, ?)`
    )
    .bind(
      makeId("llm"),
      input.organizationId,
      input.workspaceId,
      input.model,
      input.promptTokens ?? 0,
      input.completionTokens ?? 0,
      input.totalTokens ?? 0,
      input.requestType,
      input.sourceMessageId,
      nowIso()
    )
    .run();
}

async function dispatchNativeAgentRuntime(
  env: Env,
  input: {
    refs: NativeAgentRefs;
    workspaceId: string;
    channelId: string;
    authorHandle: string;
    authorEmail: string;
    authorDisplayName: string | null;
    messageId: string;
    text: string;
    threadRootId?: string | null;
    occurredAt: string;
    shouldRespond: boolean;
  }
): Promise<{
  usedTools?: boolean;
  createdTaskIds?: string[];
  updatedTaskIds?: string[];
  reply?: { messageId?: string; text?: string };
} | null> {
  const baseUrl = env.THANE_BOT_INTERNAL_BASE_URL?.trim().replace(/\/+$/g, "");
  const bearerToken = env.INTERNAL_API_BEARER_TOKEN?.trim();
  if (!baseUrl || !bearerToken) {
    return null;
  }
  const response = await fetch(`${baseUrl}/internal/thane-chat/agent-message`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      organizationId: input.refs.organizationId,
      workspaceId: input.workspaceId,
      conversationSourceId: input.refs.conversationSourceId,
      channelId: input.channelId,
      authorExternalUserId: input.authorHandle,
      authorEmail: input.authorEmail,
      authorDisplayName: input.authorDisplayName,
      messageId: input.messageId,
      text: input.text,
      threadRootId: input.threadRootId,
      occurredAt: input.occurredAt,
      shouldRespond: input.shouldRespond
    })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    usedTools?: boolean;
    createdTaskIds?: string[];
    updatedTaskIds?: string[];
    reply?: { messageId?: string; text?: string };
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `native_agent_runtime_failed:${response.status}`);
  }
  return payload;
}

async function maybeRespondWithNativeAskThane(
  env: Env,
  input: {
    workspaceId: string;
    workspaceName: string;
    channelId: string;
    channelName: string;
    text: string;
    sourceMessageId: string;
    threadRootId?: string | null;
  }
): Promise<{ messageId?: string; text?: string; reason?: string }> {
  if (!/@thane\b/i.test(input.text)) {
    return { reason: "not_mentioned" };
  }
  const gate = await nativeAiGate(env, input.workspaceId);
  if (!gate.ok) {
    return { reason: gate.reason ?? "billing_gate_blocked" };
  }
  const integration = await askThaneIntegrationForWorkspace(env, input.workspaceId);
  if (!integration || integration.enabled !== 1) {
    return { reason: "disabled" };
  }
  const bot = integration.bot_member_id
    ? await env.DB
        .prepare("SELECT id, account_id, email, display_name, handle, role FROM thane_cli_workspace_members WHERE workspace_id = ? AND id = ? LIMIT 1")
        .bind(input.workspaceId, integration.bot_member_id)
        .first<{ id: string; account_id: string; email: string; display_name: string | null; handle: string; role: string }>()
    : await ensureAskThaneMember(env, input.workspaceId);
  const botMember = bot?.id ? bot : await ensureAskThaneMember(env, input.workspaceId);
  const replyThreadRootId = input.threadRootId || null;
  const context = await recentThaneChatContext(env, {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadRootId: replyThreadRootId
  });
  const reply = await generateNativeAskThaneReply(env, {
    workspaceName: input.workspaceName,
    channelName: input.channelName,
    context,
    text: input.text
  });
  if (!reply) {
    return { reason: "no_reply" };
  }
  const createdAt = nowIso();
  const messageId = makeId("tmsg");
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_chat_messages (
         id, workspace_id, channel_id, author_member_id, text, source, thread_root_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?)`
    )
    .bind(messageId, input.workspaceId, input.channelId, botMember.id, reply.text, replyThreadRootId, createdAt, createdAt)
    .run();
  await recordNativeLlmUsage(env, {
    organizationId: input.workspaceId,
    workspaceId: input.workspaceId,
    model: reply.model,
    sourceMessageId: input.sourceMessageId,
    requestType: "native_ask_thane_reply",
    ...(reply.usage?.prompt_tokens !== undefined ? { promptTokens: reply.usage.prompt_tokens } : {}),
    ...(reply.usage?.completion_tokens !== undefined ? { completionTokens: reply.usage.completion_tokens } : {}),
    ...(reply.usage?.total_tokens !== undefined ? { totalTokens: reply.usage.total_tokens } : {})
  }).catch((error) => {
    console.warn("native_ask_thane_usage_record_failed", {
      workspaceId: input.workspaceId,
      reason: error instanceof Error ? error.message : String(error)
    });
  });
  await env.DB
    .prepare("UPDATE thane_cli_ask_thane_integrations SET bot_member_id = ?, last_event_at = ?, updated_at = ? WHERE workspace_id = ?")
    .bind(botMember.id, createdAt, createdAt, input.workspaceId)
    .run();
  return { messageId, text: reply.text };
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
  const source = payload?.source === "terminal" ? "terminal" : "chat";
  const mentionsAskThane = source === "chat" && /@thane\b/i.test(text);
  const messageRateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "message_create",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 120,
    workspaceLimit: 1_200,
    windowSeconds: 60
  });
  if (messageRateLimited) {
    return messageRateLimited;
  }
  if (mentionsAskThane) {
    const askThaneRateLimited = await enforceWorkspaceActionRateLimits(env, {
      action: "ask_thane_mention",
      workspaceId,
      memberId: member.id,
      email: member.email,
      memberLimit: 10,
      workspaceLimit: 60,
      windowSeconds: 60
    });
    if (askThaneRateLimited) {
      return askThaneRateLimited;
    }
  }
  const workspace = await env.DB
    .prepare("SELECT id, workspace_name, workspace_slug FROM thane_cli_workspaces WHERE id = ? LIMIT 1")
    .bind(workspaceId)
    .first<{ id: string; workspace_name: string | null; workspace_slug: string }>();
  const channelId = typeof payload?.channelId === "string" && payload.channelId.trim() ? payload.channelId.trim() : null;
  const channelName = normalizeChannelName(payload?.channelName);
  const channel = channelId
    ? await env.DB
        .prepare("SELECT id, name, kind, visibility FROM thane_cli_channels WHERE workspace_id = ? AND id = ? LIMIT 1")
        .bind(workspaceId, channelId)
        .first<{
          id: string;
          name: string;
          kind: ThaneCliConversationKind;
          visibility: ThaneCliConversationVisibility;
        }>()
    : channelName
    ? await ensureThaneCliChannel(env, workspaceId, channelName)
    : null;
  if (!channel?.id || !channel.kind || !channel.visibility) {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  if (!(await canThaneCliMemberUseChannel(env, { channelId: channel.id, visibility: channel.visibility, memberId: member.id }))) {
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 404 });
  }
  const createdAt = nowIso();
  const messageId = makeId("tmsg");
  const threadRootId = typeof payload?.threadRootId === "string" && payload.threadRootId.trim() ? payload.threadRootId.trim() : null;
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_chat_messages (
         id, workspace_id, channel_id, author_member_id, text, source, thread_root_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(messageId, workspaceId, channel.id, member.id, text, source, threadRootId, createdAt, createdAt)
    .run();
  let passiveTaskCount = 0;
  let nativeRuntimeReply: { messageId?: string; text?: string } | null = null;
  let usedSharedNativeRuntime = false;
  if (source === "chat" && workspace?.id) {
    const refs = await ensureNativeAgentRefs(env, {
      workspaceId,
      workspaceSlug: workspace.workspace_slug,
      workspaceName: workspace.workspace_name || workspace.workspace_slug,
      channelId: channel.id,
      channelName: channel.name,
      channelKind: channel.kind,
      channelVisibility: channel.visibility,
      memberId: member.id,
      memberHandle: member.handle,
      memberDisplayName: member.display_name,
      memberEmail: member.email,
      memberRole: member.role
    });
    const shouldRespond = mentionsAskThane;
    const runtimeResult = await dispatchNativeAgentRuntime(env, {
      refs,
      workspaceId,
      channelId: channel.id,
      authorHandle: member.handle,
      authorEmail: member.email,
      authorDisplayName: member.display_name,
      messageId,
      text,
      threadRootId,
      occurredAt: createdAt,
      shouldRespond
    }).catch((error) => {
      console.warn("native_agent_runtime_failed", {
        workspaceId,
        channelId: channel.id,
        reason: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    if (runtimeResult) {
      usedSharedNativeRuntime = true;
      passiveTaskCount = runtimeResult.createdTaskIds?.length ?? 0;
      nativeRuntimeReply = runtimeResult.reply ?? null;
    } else {
      passiveTaskCount = await inferNativeTasksFromMessage(env, {
        refs,
        text,
        messageId,
        channelId: channel.id,
        authorHandle: member.handle,
        authorDisplayName: member.display_name,
        occurredAt: createdAt
      }).catch((error) => {
        console.warn("native_task_extraction_failed", {
          workspaceId,
          channelId: channel.id,
          reason: error instanceof Error ? error.message : String(error)
        });
        return 0;
      });
    }
  }
  const askThaneReply: { messageId?: string; text?: string; reason?: string } =
    nativeRuntimeReply
      ? nativeRuntimeReply
      : usedSharedNativeRuntime
        ? { reason: "handled_by_shared_runtime" }
        : source === "chat"
      ? await maybeRespondWithNativeAskThane(env, {
          workspaceId,
          workspaceName: workspace?.workspace_name || workspace?.workspace_slug || workspaceId,
          channelId: channel.id,
          channelName: channel.name,
          text,
          sourceMessageId: messageId,
          threadRootId
        }).catch((error) => {
          console.warn("native_ask_thane_reply_failed", {
            workspaceId,
            channelId: channel.id,
            reason: error instanceof Error ? error.message : String(error)
          });
          return { reason: "failed" };
        })
        : { reason: "non_chat_source" };
  await broadcastThaneChatEvent(env, {
    type: "message_created",
    workspaceId,
    channelId: channel.id,
    messageId,
    occurredAt: nowIso()
  }).catch((error) => {
    console.warn("thane_chat_event_broadcast_failed", {
      workspaceId,
      channelId: channel.id,
      reason: error instanceof Error ? error.message : String(error)
    });
  });
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
    },
    passiveTaskCount,
    ...(askThaneReply.messageId ? { askThaneReply } : {})
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
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "reaction_create",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 240,
    workspaceLimit: 2_000,
    windowSeconds: 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const message = await env.DB
    .prepare(
      `SELECT msg.id, c.id AS channel_id, c.visibility
       FROM thane_cli_chat_messages msg
       JOIN thane_cli_channels c ON c.id = msg.channel_id
       WHERE msg.workspace_id = ? AND msg.id = ?
       LIMIT 1`
    )
    .bind(workspaceId, messageId)
    .first<{ id: string; channel_id: string; visibility: ThaneCliConversationVisibility }>();
  if (!message?.id) {
    return Response.json({ ok: false, error: "message_not_found" }, { status: 404 });
  }
  if (!(await canThaneCliMemberUseChannel(env, { channelId: message.channel_id, visibility: message.visibility, memberId: member.id }))) {
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
  await broadcastThaneChatEvent(env, {
    type: "reaction_created",
    workspaceId,
    channelId: message.channel_id,
    messageId,
    occurredAt: createdAt
  }).catch((error) => {
    console.warn("thane_chat_event_broadcast_failed", {
      workspaceId,
      channelId: message.channel_id,
      reason: error instanceof Error ? error.message : String(error)
    });
  });
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
  const inviteRateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: inviteeEmail ? "invite_email_create" : "invite_link_create",
    workspaceId: workspaceRow.id,
    memberId: member.id,
    email: member.email,
    memberLimit: inviteeEmail ? 20 : 60,
    workspaceLimit: inviteeEmail ? 200 : 500,
    windowSeconds: 60 * 60
  });
  if (inviteRateLimited) {
    return inviteRateLimited;
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
    const recipientRateLimited = await enforceRateLimits(env, [
      {
        purpose: "thane_cli_invite_email:recipient_hour",
        key: `${workspace.id}:${inviteeEmail}`,
        keyHint: inviteeEmail,
        limit: 5,
        windowSeconds: 60 * 60
      },
      {
        purpose: "thane_cli_invite_email:recipient_day",
        key: `${workspace.id}:${inviteeEmail}`,
        keyHint: inviteeEmail,
        limit: 20,
        windowSeconds: 24 * 60 * 60
      }
    ]);
    if (recipientRateLimited) {
      return recipientRateLimited;
    }
  }

  const token = makeInviteToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  const inviteId = makeId("inv");
  const tokenHash = await hashInviteToken(token);
  try {
    await env.DB
      .prepare(
        `INSERT INTO thane_cli_workspace_invites (
           id, token_hash, workspace_id, workspace_slug, workspace_name, role,
           created_by_email, created_at, expires_at, max_uses, invitee_email
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(inviteId, tokenHash, workspace.id, workspace.slug, workspace.name, role, email, createdAt, expiresAt, maxUses, inviteeEmail)
      .run();
  } catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes("no such column") || !message.includes("invitee_email")) {
      throw error;
    }
    await env.DB
      .prepare(
        `INSERT INTO thane_cli_workspace_invites (
           id, token_hash, workspace_id, workspace_slug, workspace_name, role,
           created_by_email, created_at, expires_at, max_uses
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(inviteId, tokenHash, workspace.id, workspace.slug, workspace.name, role, email, createdAt, expiresAt, maxUses)
      .run();
  }

  const url = `${inviteBaseUrl(env, request)}/${token}`;
  const webUrl = appendInviteeEmailToUrl(`${webInviteBaseUrl(env)}/${token}`, inviteeEmail);
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
      expiresAt: row!.expires_at,
      ...(row!.invitee_email ? { inviteeEmail: row!.invitee_email } : {})
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
  const rateLimited = await enforceAuthenticatedActionRateLimits(request, env, {
    action: "invite_accept",
    email,
    emailLimit: 30,
    ipLimit: 300,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const row = await inviteByToken(env, token);
  const invalid = validateInvite(row);
  if (invalid) {
    return invalid;
  }
  if (await isThaneCliWorkspaceBanned(env, row!.workspace_id, email)) {
    return Response.json({ ok: false, error: "workspace_banned" }, { status: 403 });
  }
  if (row!.invitee_email && normalizeEmail(row!.invitee_email) !== email) {
    return Response.json({ ok: false, error: "invite_email_mismatch" }, { status: 403 });
  }
  const existingMember = await requireThaneCliWorkspaceMember(env, row!.workspace_id, email);
  if (!existingMember) {
    const planTier = await thaneCliWorkspacePlanTier(env, row!.workspace_id);
    const memberCount = await countThaneCliWorkspaceMembers(env, row!.workspace_id);
    if (!isThaneCliTeam(planTier) && memberCount >= THANE_CLI_FREE_LIMITS.members) {
      return thaneCliLimitReachedResponse("thane_chat_member_limit_reached", THANE_CLI_FREE_LIMITS.members);
    }
  }
  await env.DB
    .prepare("UPDATE thane_cli_workspace_invites SET accepted_count = accepted_count + 1 WHERE id = ?")
    .bind(row!.id)
    .run();
  await ensureThaneCliMember(env, {
    workspaceId: row!.workspace_id,
    email,
    displayName: await profileDisplayNameForEmail(env, email),
    role: row!.role
  });
  return Response.json({
    ok: true,
    workspace: renderInviteWorkspace(row!),
    acceptedBy: email
  });
}

async function removeThaneCliWorkspaceMember(env: Env, input: {
  workspaceId: string;
  memberId: string;
}): Promise<void> {
  await env.DB.prepare("DELETE FROM thane_cli_channel_members WHERE member_id = ?").bind(input.memberId).run();
  await env.DB.prepare("DELETE FROM thane_cli_workspace_members WHERE workspace_id = ? AND id = ?").bind(input.workspaceId, input.memberId).run();
}

async function handleThaneCliWorkspaceLeave(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliWorkspaceMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  if (!workspaceId) {
    return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "workspace_leave",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 20,
    workspaceLimit: 200,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  if (member.role === "owner" && (await countThaneCliWorkspaceOwners(env, workspaceId)) <= 1) {
    return Response.json({ ok: false, error: "last_owner_cannot_leave" }, { status: 409 });
  }
  await removeThaneCliWorkspaceMember(env, { workspaceId, memberId: member.id });
  return Response.json({ ok: true, workspaceId, left: true });
}

async function handleThaneCliWorkspaceMemberRemove(request: Request, env: Env, ban: boolean): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliWorkspaceMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const target = typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null;
  const reason = typeof payload?.reason === "string" && payload.reason.trim() ? payload.reason.trim().slice(0, 500) : null;
  if (!workspaceId || !target) {
    return Response.json({ ok: false, error: "workspace_id_and_target_required" }, { status: 400 });
  }
  const actor = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!actor) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  if (!isThaneCliWorkspaceAdmin(actor.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: ban ? "workspace_member_ban" : "workspace_member_remove",
    workspaceId,
    memberId: actor.id,
    email: actor.email,
    memberLimit: 60,
    workspaceLimit: 500,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const targetMember = await resolveThaneCliWorkspaceMember(env, { workspaceId, target });
  if (!targetMember) {
    return Response.json({ ok: false, error: "member_not_found" }, { status: 404 });
  }
  if (targetMember.id === actor.id) {
    return Response.json({ ok: false, error: ban ? "cannot_ban_self" : "cannot_remove_self" }, { status: 400 });
  }
  if (targetMember.role === "owner" && (await countThaneCliWorkspaceOwners(env, workspaceId)) <= 1) {
    return Response.json({ ok: false, error: "last_owner_cannot_be_removed" }, { status: 409 });
  }
  if (targetMember.role === "owner" && actor.role !== "owner") {
    return Response.json({ ok: false, error: "owner_required" }, { status: 403 });
  }
  if (ban) {
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO thane_cli_workspace_bans (id, workspace_id, email, banned_by_member_id, reason, banned_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, email) DO UPDATE SET
           banned_by_member_id = excluded.banned_by_member_id,
           reason = excluded.reason,
           banned_at = excluded.banned_at,
           updated_at = excluded.updated_at`
      )
      .bind(makeId("tcb"), workspaceId, targetMember.email, actor.id, reason, now, now)
      .run();
  }
  await removeThaneCliWorkspaceMember(env, { workspaceId, memberId: targetMember.id });
  return Response.json({ ok: true, workspaceId, memberId: targetMember.id, email: targetMember.email, removed: true, banned: ban });
}

async function handleThaneCliWorkspaceMemberUnban(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliWorkspaceMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const target = typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null;
  if (!workspaceId || !target) {
    return Response.json({ ok: false, error: "workspace_id_and_target_required" }, { status: 400 });
  }
  const actor = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!actor) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  if (!isThaneCliWorkspaceAdmin(actor.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "workspace_member_unban",
    workspaceId,
    memberId: actor.id,
    email: actor.email,
    memberLimit: 60,
    workspaceLimit: 500,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  await env.DB.prepare("DELETE FROM thane_cli_workspace_bans WHERE workspace_id = ? AND email = ?").bind(workspaceId, normalizeEmail(target)).run();
  return Response.json({ ok: true, workspaceId, email: normalizeEmail(target), unbanned: true });
}

async function handleThaneCliWorkspaceMemberRole(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliWorkspaceMembershipPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : null;
  const target = typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null;
  const role = payload?.role === "admin" || payload?.role === "member" ? payload.role : null;
  if (!workspaceId || !target || !role) {
    return Response.json({ ok: false, error: "workspace_id_target_and_role_required" }, { status: 400 });
  }
  const actor = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!actor) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  if (!isThaneCliWorkspaceAdmin(actor.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "workspace_member_role",
    workspaceId,
    memberId: actor.id,
    email: actor.email,
    memberLimit: 60,
    workspaceLimit: 500,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  if (role === "admin" && actor.role !== "owner") {
    return Response.json({ ok: false, error: "owner_required" }, { status: 403 });
  }
  const targetMember = await resolveThaneCliWorkspaceMember(env, { workspaceId, target });
  if (!targetMember) {
    return Response.json({ ok: false, error: "member_not_found" }, { status: 404 });
  }
  if (targetMember.role === "owner") {
    return Response.json({ ok: false, error: "owner_required" }, { status: 403 });
  }
  await env.DB
    .prepare("UPDATE thane_cli_workspace_members SET role = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .bind(role, nowIso(), workspaceId, targetMember.id)
    .run();
  return Response.json({ ok: true, workspaceId, memberId: targetMember.id, role });
}

async function handleThaneCliBillingLinkCreate(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliBillingLinkPayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim().slice(0, 120) : null;
  if (!workspaceId) {
    return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  if (!isThaneCliWorkspaceAdmin(member.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const workspace = await env.DB
    .prepare("SELECT id, workspace_slug, plan_tier FROM thane_cli_workspaces WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(workspaceId)
    .first<{ id?: string; workspace_slug?: string; plan_tier?: string | null }>();
  if (!workspace?.id) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "billing_link",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 20,
    workspaceLimit: 100,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signBillingLinkToken(env, {
    organizationId: workspace.id,
    workspaceId: workspace.id,
    planTier: "cli_team",
    iat: issuedAt,
    exp: issuedAt + 15 * 60
  });
  const paymentsBaseUrl = (env.THANE_PAYMENTS_BASE_URL?.trim() || "https://payments.askthane.com").replace(/\/+$/g, "");
  const checkoutUrl = new URL("/subscribe", paymentsBaseUrl);
  checkoutUrl.searchParams.set("plan_tier", "cli_team");
  checkoutUrl.searchParams.set("billing_token", token);
  checkoutUrl.searchParams.set("autostart", "1");
  checkoutUrl.searchParams.set("email", email);
  if (typeof payload?.returnUrl === "string" && payload.returnUrl.trim()) {
    checkoutUrl.searchParams.set("return_url", payload.returnUrl.trim().slice(0, 500));
  }
  const portalUrl = new URL("/subscribe", paymentsBaseUrl);
  portalUrl.searchParams.set("billing_token", token);
  portalUrl.searchParams.set("email", email);
  if (typeof payload?.returnUrl === "string" && payload.returnUrl.trim()) {
    portalUrl.searchParams.set("return_url", payload.returnUrl.trim().slice(0, 500));
  }
  return Response.json({
    ok: true,
    billing: {
      workspaceId: workspace.id,
      planTier: workspace.plan_tier === "cli_team" ? "cli_team" : "free",
      targetPlanTier: "cli_team",
      checkoutUrl: checkoutUrl.toString(),
      portalUrl: portalUrl.toString(),
      expiresAt: new Date((issuedAt + 15 * 60) * 1000).toISOString()
    }
  });
}

async function handleThaneCliAskThaneStatus(request: Request, env: Env): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId")?.trim() || null;
  if (!workspaceId) {
    return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  const integration = renderAskThaneIntegration(await askThaneIntegrationForWorkspace(env, workspaceId));
  return Response.json({ ok: true, integration });
}

async function handleThaneCliAskThaneToggle(request: Request, env: Env, enabled: boolean): Promise<Response> {
  const email = await requireAuthEmail(request, env);
  if (!email) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const payload = await parseJsonObject<ThaneCliAskThanePayload>(request);
  const workspaceId = typeof payload?.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim().slice(0, 120) : null;
  if (!workspaceId) {
    return Response.json({ ok: false, error: "workspace_id_required" }, { status: 400 });
  }
  const member = await requireThaneCliWorkspaceMember(env, workspaceId, email);
  if (!member) {
    return Response.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  }
  if (!isThaneCliWorkspaceAdmin(member.role)) {
    return Response.json({ ok: false, error: "workspace_admin_required" }, { status: 403 });
  }
  const rateLimited = await enforceWorkspaceActionRateLimits(env, {
    action: "ask_thane_toggle",
    workspaceId,
    memberId: member.id,
    email: member.email,
    memberLimit: 30,
    workspaceLimit: 200,
    windowSeconds: 60 * 60
  });
  if (rateLimited) {
    return rateLimited;
  }
  const bot = await ensureAskThaneMember(env, workspaceId);
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO thane_cli_ask_thane_integrations (
         workspace_id, enabled, bot_member_id, linked_account_email, connected_at, updated_at, last_event_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         enabled = excluded.enabled,
         bot_member_id = excluded.bot_member_id,
         linked_account_email = excluded.linked_account_email,
         updated_at = excluded.updated_at,
         last_event_at = excluded.last_event_at`
    )
    .bind(workspaceId, enabled ? 1 : 0, bot.id, email, now, now, now)
    .run();
  const integration = renderAskThaneIntegration(await askThaneIntegrationForWorkspace(env, workspaceId));
  return Response.json({ ok: true, integration });
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
  if (url.pathname === "/v1/thane-cli/ask-thane/status" && request.method === "GET") {
    return handleThaneCliAskThaneStatus(request, env);
  }
  if (url.pathname === "/v1/thane-cli/ask-thane/enable" && request.method === "POST") {
    return handleThaneCliAskThaneToggle(request, env, true);
  }
  if (url.pathname === "/v1/thane-cli/ask-thane/disable" && request.method === "POST") {
    return handleThaneCliAskThaneToggle(request, env, false);
  }
  if (url.pathname === "/v1/thane-cli/workspaces" && request.method === "POST") {
    return handleThaneCliWorkspaceEnsure(request, env);
  }
  if (url.pathname === "/v1/thane-cli/workspaces/leave" && request.method === "POST") {
    return handleThaneCliWorkspaceLeave(request, env);
  }
  if (url.pathname === "/v1/thane-cli/workspace-members/remove" && request.method === "POST") {
    return handleThaneCliWorkspaceMemberRemove(request, env, false);
  }
  if (url.pathname === "/v1/thane-cli/workspace-members/ban" && request.method === "POST") {
    return handleThaneCliWorkspaceMemberRemove(request, env, true);
  }
  if (url.pathname === "/v1/thane-cli/workspace-members/unban" && request.method === "POST") {
    return handleThaneCliWorkspaceMemberUnban(request, env);
  }
  if (url.pathname === "/v1/thane-cli/workspace-members/role" && request.method === "POST") {
    return handleThaneCliWorkspaceMemberRole(request, env);
  }
  if (url.pathname === "/v1/thane-cli/sync" && request.method === "GET") {
    return buildThaneCliSyncResponse(request, env);
  }
  if (url.pathname === "/v1/thane-cli/events" && request.method === "GET") {
    return handleThaneCliEvents(request, env);
  }
  if (url.pathname === "/v1/thane-cli/channels" && request.method === "POST") {
    return handleThaneCliChannelCreate(request, env);
  }
  if (url.pathname === "/v1/thane-cli/channels/join" && request.method === "POST") {
    return handleThaneCliChannelJoin(request, env);
  }
  if (url.pathname === "/v1/thane-cli/channels/leave" && request.method === "POST") {
    return handleThaneCliChannelLeave(request, env);
  }
  if (url.pathname === "/v1/thane-cli/channel-members/add" && request.method === "POST") {
    return handleThaneCliChannelMemberAdd(request, env);
  }
  if (url.pathname === "/v1/thane-cli/channel-members/remove" && request.method === "POST") {
    return handleThaneCliChannelMemberRemove(request, env);
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
  if (url.pathname === "/v1/thane-cli/billing/link" && request.method === "POST") {
    return handleThaneCliBillingLinkCreate(request, env);
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
