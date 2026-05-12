import { OrgRegistry } from "../services/org-registry";
import { SlackInstallStore } from "../services/slack-install-store";
import type { BotEnv } from "../services/task-inference";

const DEFAULT_SCOPES =
  "channels:history,groups:history,channels:read,groups:read,im:read,mpim:read,chat:write,chat:write.public,im:write";
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  ts: number;
  nonce: string;
}

interface SlackOAuthResponse {
  ok?: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
  authed_user?: {
    id?: string;
  };
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
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

async function signState(payloadPart: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart));

  let binary = "";
  const bytes = new Uint8Array(signature);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return base64UrlEncode(binary);
}

async function issueState(secret: string): Promise<string> {
  const payload: StatePayload = {
    ts: Date.now(),
    nonce: crypto.randomUUID()
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const sigPart = await signState(payloadPart, secret);
  return `${payloadPart}.${sigPart}`;
}

async function verifyState(state: string, secret: string): Promise<boolean> {
  const [payloadPart, sigPart] = state.split(".");
  if (!payloadPart || !sigPart) {
    return false;
  }

  const expectedSig = await signState(payloadPart, secret);
  if (!constantTimeEqual(sigPart, expectedSig)) {
    return false;
  }

  const payloadRaw = base64UrlDecode(payloadPart);
  const parsed = JSON.parse(payloadRaw) as StatePayload;
  if (typeof parsed.ts !== "number") {
    return false;
  }

  return Date.now() - parsed.ts <= STATE_TTL_MS;
}

function resolveRedirectUri(request: Request, env: BotEnv): string {
  if (env.SLACK_REDIRECT_URI) {
    return env.SLACK_REDIRECT_URI;
  }

  if (env.THANE_BASE_URL) {
    return `${env.THANE_BASE_URL.replace(/\/$/, "")}/slack/oauth/callback`;
  }

  return `${new URL(request.url).origin}/slack/oauth/callback`;
}

export async function handleSlackInstallStart(request: Request, env: BotEnv): Promise<Response> {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_OAUTH_STATE_SECRET) {
    return Response.json(
      {
        ok: false,
        error: "slack_oauth_not_configured",
        required: ["SLACK_CLIENT_ID", "SLACK_OAUTH_STATE_SECRET"]
      },
      { status: 500 }
    );
  }

  const state = await issueState(env.SLACK_OAUTH_STATE_SECRET);
  const scopes = env.SLACK_BOT_SCOPES ?? DEFAULT_SCOPES;
  const redirectUri = resolveRedirectUri(request, env);

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: scopes,
    redirect_uri: redirectUri,
    state
  });

  return Response.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`, 302);
}

export async function handleSlackOAuthCallback(request: Request, env: BotEnv): Promise<Response> {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.SLACK_OAUTH_STATE_SECRET) {
    return Response.json(
      {
        ok: false,
        error: "slack_oauth_not_configured",
        required: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_OAUTH_STATE_SECRET"]
      },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const callbackError = url.searchParams.get("error");

  if (callbackError) {
    return Response.json({ ok: false, error: `slack_oauth_error:${callbackError}` }, { status: 400 });
  }

  if (!code || !state) {
    return Response.json({ ok: false, error: "missing_code_or_state" }, { status: 400 });
  }

  const isStateValid = await verifyState(state, env.SLACK_OAUTH_STATE_SECRET);
  if (!isStateValid) {
    return Response.json({ ok: false, error: "invalid_state" }, { status: 400 });
  }

  const redirectUri = resolveRedirectUri(request, env);
  const body = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri
  });

  const slackResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!slackResponse.ok) {
    return Response.json(
      { ok: false, error: `slack_oauth_http_error:${slackResponse.status}` },
      { status: 502 }
    );
  }

  const payload = (await slackResponse.json()) as SlackOAuthResponse;
  if (!payload.ok || !payload.access_token || !payload.team?.id) {
    return Response.json(
      { ok: false, error: `slack_oauth_exchange_failed:${payload.error ?? "unknown"}` },
      { status: 400 }
    );
  }

  const registry = new OrgRegistry(env.DB);
  const workspaceParams: {
    externalWorkspaceId: string;
    defaultOrganizationId?: string;
    workspaceName?: string;
  } = {
    externalWorkspaceId: payload.team.id
  };
  if (env.DEFAULT_ORGANIZATION_ID) {
    workspaceParams.defaultOrganizationId = env.DEFAULT_ORGANIZATION_ID;
  }
  if (payload.team.name) {
    workspaceParams.workspaceName = payload.team.name;
  }

  const workspaceRef = await registry.resolveOrCreateSlackWorkspace(workspaceParams);

  const nowIso = new Date().toISOString();
  const installs = new SlackInstallStore(env.DB);
  const installInput: {
    organizationId: string;
    workspaceId: string;
    externalWorkspaceId: string;
    teamName?: string;
    botToken: string;
    botUserId?: string;
    botScope?: string;
    tokenType?: string;
    installedByExternalUserId?: string;
    installedAt: string;
  } = {
    organizationId: workspaceRef.organizationId,
    workspaceId: workspaceRef.workspaceId,
    externalWorkspaceId: payload.team.id,
    botToken: payload.access_token,
    installedAt: nowIso
  };
  if (payload.team.name) {
    installInput.teamName = payload.team.name;
  }
  if (payload.bot_user_id) {
    installInput.botUserId = payload.bot_user_id;
  }
  if (payload.scope) {
    installInput.botScope = payload.scope;
  }
  if (payload.token_type) {
    installInput.tokenType = payload.token_type;
  }
  if (payload.authed_user?.id) {
    installInput.installedByExternalUserId = payload.authed_user.id;
  }
  await installs.upsertWorkspaceInstall(installInput);

  return Response.json(
    {
      ok: true,
      installed: true,
      organizationId: workspaceRef.organizationId,
      workspaceId: workspaceRef.workspaceId,
      externalWorkspaceId: payload.team.id,
      teamName: payload.team.name ?? null
    },
    { status: 200 }
  );
}
