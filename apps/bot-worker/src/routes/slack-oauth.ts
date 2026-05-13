import { OrgRegistry } from "../services/org-registry";
import { SlackInstallStore } from "../services/slack-install-store";
import type { BotEnv } from "../services/task-inference";

const DEFAULT_SCOPES =
  "channels:history,groups:history,channels:read,groups:read,im:read,mpim:read,chat:write,chat:write.public,im:write,reactions:write";
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

function wantsHtml(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

function renderInstallPage(input: {
  title: string;
  message: string;
  details?: string[];
  ok: boolean;
}): Response {
  const detailsHtml = (input.details ?? [])
    .map((item) => `<li>${item}</li>`)
    .join("");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${input.title}</title>
    <style>
      :root {
        --bg: #f7f4ed;
        --ink: #141414;
        --muted: #5e5e5e;
        --ok: #0b6b2d;
        --bad: #b42318;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background: radial-gradient(circle at top right, #f7e7cf 0%, var(--bg) 45%);
        color: var(--ink);
        padding: 24px;
      }
      .card {
        width: min(720px, 100%);
        background: #fffdf8;
        border: 1px solid #e8dfd0;
        border-radius: 16px;
        padding: 28px;
      }
      h1 { margin: 0 0 10px; font-size: clamp(1.5rem, 3.8vw, 2.1rem); }
      p { margin: 0; line-height: 1.6; color: var(--muted); }
      .status {
        display: inline-block;
        margin-bottom: 14px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: ${input.ok ? "var(--ok)" : "var(--bad)"};
      }
      ul { margin: 18px 0 0; padding-left: 20px; color: var(--muted); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4efe3; padding: 1px 5px; border-radius: 5px; }
    </style>
  </head>
  <body>
    <section class="card">
      <div class="status">${input.ok ? "Install complete" : "Install failed"}</div>
      <h1>${input.title}</h1>
      <p>${input.message}</p>
      ${detailsHtml ? `<ul>${detailsHtml}</ul>` : ""}
    </section>
  </body>
</html>`;

  return new Response(html, {
    status: input.ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
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
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Slack OAuth Not Configured",
        message: "Ask Thane is missing required OAuth configuration.",
        details: ["Required secrets: SLACK_CLIENT_ID, SLACK_OAUTH_STATE_SECRET"]
      });
    }

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
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Slack OAuth Not Configured",
        message: "Ask Thane is missing required OAuth configuration.",
        details: ["Required secrets: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_OAUTH_STATE_SECRET"]
      });
    }

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
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Slack Authorization Cancelled",
        message: "Slack returned an authorization error.",
        details: [`Error: ${callbackError}`]
      });
    }

    return Response.json({ ok: false, error: `slack_oauth_error:${callbackError}` }, { status: 400 });
  }

  if (!code || !state) {
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Missing OAuth Parameters",
        message: "Required parameters were missing in the callback request.",
        details: ["Expected query params: code and state"]
      });
    }

    return Response.json({ ok: false, error: "missing_code_or_state" }, { status: 400 });
  }

  const isStateValid = await verifyState(state, env.SLACK_OAUTH_STATE_SECRET);
  if (!isStateValid) {
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Invalid Install Session",
        message: "The OAuth state validation failed. Start the install flow again.",
        details: ["Open /slack/install and retry authorization."]
      });
    }

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
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Slack OAuth Exchange Failed",
        message: "Slack returned a non-success HTTP status during token exchange.",
        details: [`Status: ${slackResponse.status}`]
      });
    }

    return Response.json(
      { ok: false, error: `slack_oauth_http_error:${slackResponse.status}` },
      { status: 502 }
    );
  }

  const payload = (await slackResponse.json()) as SlackOAuthResponse;
  if (!payload.ok || !payload.access_token || !payload.team?.id) {
    if (wantsHtml(request)) {
      return renderInstallPage({
        ok: false,
        title: "Slack OAuth Exchange Rejected",
        message: "Slack rejected the install exchange.",
        details: [`Reason: ${payload.error ?? "unknown"}`]
      });
    }

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

  if (wantsHtml(request)) {
    return renderInstallPage({
      ok: true,
      title: "Thane Installed Successfully",
      message: "Your Slack workspace is now connected to Ask Thane.",
      details: [
        `Team: ${payload.team.name ?? payload.team.id}`,
        `External workspace ID: ${payload.team.id}`,
        "You can now add Thane to channels and continue backend setup."
      ]
    });
  }

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
