import { OrgRegistry } from "../services/org-registry";
import { SlackInstallStore } from "../services/slack-install-store";
import type { BotEnv } from "../services/task-inference";

const DEFAULT_SCOPES =
  "channels:history,groups:history,im:history,mpim:history,channels:read,groups:read,im:read,mpim:read,chat:write,chat:write.public,im:write,reactions:write";
const STATE_TTL_MS = 10 * 60 * 1000;
const RECOMMENDED_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "team:read",
  "users:read"
];

interface StatePayload {
  ts: number;
  nonce: string;
  installPlan?: "free" | "paid";
  selectedTier?: "team" | "growth" | "scale" | "scale_plus";
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
  enterprise?: {
    id?: string;
    name?: string;
  };
  is_enterprise_install?: boolean;
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
  ctaHref?: string;
  ctaLabel?: string;
  autoRedirectMs?: number;
}): Response {
  const detailsHtml = (input.details ?? [])
    .map((item) => `<li>${item}</li>`)
    .join("");
  const ctaHref = input.ctaHref?.trim();
  const ctaLabel = input.ctaLabel?.trim();
  const ctaHtml =
    ctaHref && ctaLabel
      ? `<p style="margin:18px 0 0"><a href="${ctaHref}" style="display:inline-block;background:#0f5fd7;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700">${ctaLabel}</a></p>`
      : "";
  const redirectScript =
    ctaHref && input.autoRedirectMs && input.autoRedirectMs > 0
      ? `<script>setTimeout(() => { window.location.href = ${JSON.stringify(ctaHref)}; }, ${Math.floor(input.autoRedirectMs)});</script>`
      : "";

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
      ${ctaHtml}
      ${detailsHtml ? `<ul>${detailsHtml}</ul>` : ""}
    </section>
    ${redirectScript}
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

async function issueState(input: {
  secret: string;
  installPlan?: "free" | "paid";
  selectedTier?: "team" | "growth" | "scale" | "scale_plus";
}): Promise<string> {
  const payload: StatePayload = {
    ts: Date.now(),
    nonce: crypto.randomUUID(),
    ...(input.installPlan ? { installPlan: input.installPlan } : {}),
    ...(input.selectedTier ? { selectedTier: input.selectedTier } : {})
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const sigPart = await signState(payloadPart, input.secret);
  return `${payloadPart}.${sigPart}`;
}

async function verifyState(state: string, secret: string): Promise<StatePayload | null> {
  const [payloadPart, sigPart] = state.split(".");
  if (!payloadPart || !sigPart) {
    return null;
  }

  const expectedSig = await signState(payloadPart, secret);
  if (!constantTimeEqual(sigPart, expectedSig)) {
    return null;
  }

  const payloadRaw = base64UrlDecode(payloadPart);
  const parsed = JSON.parse(payloadRaw) as StatePayload;
  if (typeof parsed.ts !== "number") {
    return null;
  }

  if (Date.now() - parsed.ts > STATE_TTL_MS) {
    return null;
  }

  return parsed;
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

function resolveSubscriptionPageUrl(env: BotEnv): string {
  const configured = env.SUBSCRIPTION_PAGE_URL?.trim();
  if (configured) {
    return configured;
  }
  return "https://payments.askthane.com/subscribe";
}

function workspaceBillingSubscribeUrl(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  selectedTier?: "team" | "growth" | "scale" | "scale_plus";
}): string {
  const base = resolveSubscriptionPageUrl(input.env);
  const url = new URL(base);
  url.searchParams.set("organization_id", input.organizationId);
  url.searchParams.set("workspace_id", input.workspaceId);
  if (input.selectedTier) {
    url.searchParams.set("plan_tier", input.selectedTier);
    url.searchParams.set("autostart", "1");
  }
  return url.toString();
}

function normalizeSelectedTier(value: string | null): "team" | "growth" | "scale" | "scale_plus" | null {
  if (value === "team" || value === "growth" || value === "scale" || value === "scale_plus") {
    return value;
  }
  return null;
}

function getMissingRecommendedScopes(scopeCsv: string | undefined): string[] {
  const configured = new Set<string>();
  for (const rawScope of (scopeCsv ?? "").split(",")) {
    const scope = rawScope.trim();
    if (scope) {
      configured.add(scope);
    }
  }
  return RECOMMENDED_SCOPES.filter((scope) => !configured.has(scope));
}

async function sendInstallOnboardingDm(input: {
  botToken: string;
  installerExternalUserId?: string;
  installPlan: "free" | "paid";
  billingSubscribeUrl: string;
}): Promise<void> {
  const userId = input.installerExternalUserId?.trim();
  if (!userId) {
    return;
  }

  const onboardingLines = [
    "Thane is installed for your workspace.",
    "Next step: add me to any channel where you want automatic task tracking.",
    "In that channel, run: /invite @Thane",
    "Then assign a task naturally (for example: \"Alex, please send the draft by Friday\")."
  ];
  if (input.installPlan === "paid") {
    onboardingLines.push(`To activate paid features now: ${input.billingSubscribeUrl}`);
  }

  try {
    const openResponse = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.botToken}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ users: userId })
    });
    const openPayload = (await openResponse.json()) as {
      ok?: boolean;
      channel?: { id?: string };
    };
    const channelId = openPayload.ok ? openPayload.channel?.id : undefined;
    if (!channelId) {
      return;
    }

    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.botToken}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        channel: channelId,
        text: onboardingLines.join("\n")
      })
    });
  } catch {
    // Non-fatal: install success should not be blocked by onboarding DM failures.
  }
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

  const requestedPlan = new URL(request.url).searchParams.get("plan");
  const installPlan: "free" | "paid" = requestedPlan === "paid" ? "paid" : "free";
  const requestedTier = normalizeSelectedTier(new URL(request.url).searchParams.get("tier"));
  const selectedTier = installPlan === "paid" ? requestedTier ?? "team" : undefined;
  const state = await issueState({
    secret: env.SLACK_OAUTH_STATE_SECRET,
    installPlan,
    ...(selectedTier ? { selectedTier } : {})
  });
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

  const statePayload = await verifyState(state, env.SLACK_OAUTH_STATE_SECRET);
  if (!statePayload) {
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
    workspaceName?: string;
    externalOrganizationId?: string;
    organizationName?: string;
  } = {
    externalWorkspaceId: payload.team.id
  };
  if (payload.team.name) {
    workspaceParams.workspaceName = payload.team.name;
  }
  if (payload.enterprise?.id) {
    workspaceParams.externalOrganizationId = payload.enterprise.id;
  }
  if (payload.enterprise?.name) {
    workspaceParams.organizationName = payload.enterprise.name;
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
  const missingScopes = getMissingRecommendedScopes(payload.scope);
  const installPlan = statePayload.installPlan ?? "free";
  const selectedTier = installPlan === "paid" ? statePayload.selectedTier ?? "team" : undefined;
  const billingSubscribeUrl = workspaceBillingSubscribeUrl({
    env,
    organizationId: workspaceRef.organizationId,
    workspaceId: workspaceRef.workspaceId,
    ...(selectedTier ? { selectedTier } : {})
  });
  await sendInstallOnboardingDm({
    botToken: payload.access_token,
    ...(payload.authed_user?.id ? { installerExternalUserId: payload.authed_user.id } : {}),
    installPlan,
    billingSubscribeUrl
  });

  if (wantsHtml(request)) {
    if (installPlan === "paid") {
      return renderInstallPage({
        ok: true,
        title: "Slack Connected: Continue To Checkout",
        message:
          "Your workspace is now linked to Thane. Continue to Stripe checkout to activate the selected paid plan.",
        ctaHref: billingSubscribeUrl,
        ctaLabel: "Continue To Stripe Checkout",
        autoRedirectMs: 1500,
        details: [
          `Team: ${payload.team.name ?? payload.team.id}`,
          `External workspace ID: ${payload.team.id}`,
          ...(selectedTier ? [`Selected paid tier: ${selectedTier}`] : []),
          "Add Thane to channels with: /invite @Thane",
          ...(missingScopes.length > 0 ? [`Missing recommended scopes: ${missingScopes.join(", ")}`] : [])
        ]
      });
    }

    return renderInstallPage({
      ok: true,
      title: "Thane Installed Successfully",
      message: "Your Slack workspace is now connected to Ask Thane.",
      details: [
        `Team: ${payload.team.name ?? payload.team.id}`,
        `External workspace ID: ${payload.team.id}`,
        "Add Thane to channels with: /invite @Thane",
        ...(missingScopes.length > 0 ? [`Missing recommended scopes: ${missingScopes.join(", ")}`] : []),
        `Optional upgrade: ${billingSubscribeUrl}`,
        "After inviting Thane to a channel, assign a task in normal language."
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
      teamName: payload.team.name ?? null,
      installPlan,
      ...(selectedTier ? { selectedTier } : {}),
      billingSubscribeUrl,
      nextStep: installPlan === "paid" ? "checkout" : "use_free_tier",
      missingRecommendedScopes: missingScopes
    },
    { status: 200 }
  );
}
