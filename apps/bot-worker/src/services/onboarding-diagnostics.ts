import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface SlackAuthTestResponse {
  ok?: boolean;
  error?: string;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  bot_id?: string;
  url?: string;
}

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

function parseScopes(scopeRaw: string | null): Set<string> {
  const scopes = new Set<string>();
  for (const scope of (scopeRaw ?? "").split(",")) {
    const trimmed = scope.trim();
    if (trimmed) {
      scopes.add(trimmed);
    }
  }
  return scopes;
}

async function slackAuthTest(botToken: string): Promise<SlackAuthTestResponse> {
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: {
      Authorization: `Bearer ${botToken}`
    }
  });
  if (!response.ok) {
    return { ok: false, error: `auth_test_http_${response.status}` };
  }
  return (await response.json()) as SlackAuthTestResponse;
}

export async function getSlackInstallDiagnostics(env: BotEnv): Promise<Record<string, unknown>> {
  const installs = new SlackInstallStore(env.DB);
  const installed = await installs.listWorkspaceInstalls();

  const results: Array<Record<string, unknown>> = [];
  for (const install of installed) {
    const installMeta = await env.DB
      .prepare(
        `SELECT team_name, bot_scope, token_type, installed_at, updated_at
         FROM slack_workspace_installs
         WHERE workspace_id = ?
         LIMIT 1`
      )
      .bind(install.workspaceId)
      .first<Record<string, unknown>>();

    const workspace = await env.DB
      .prepare(
        `SELECT name, platform, external_workspace_id
         FROM workspaces
         WHERE id = ?
         LIMIT 1`
      )
      .bind(install.workspaceId)
      .first<Record<string, unknown>>();

    const auth = await slackAuthTest(install.botToken);
    const configuredScopes = parseScopes(installMeta?.bot_scope ? String(installMeta.bot_scope) : null);
    const missingScopes = RECOMMENDED_SCOPES.filter((scope) => !configuredScopes.has(scope));

    results.push({
      organizationId: install.organizationId,
      workspaceId: install.workspaceId,
      externalWorkspaceId: install.externalWorkspaceId,
      workspaceName: workspace?.name ? String(workspace.name) : null,
      teamName: installMeta?.team_name ? String(installMeta.team_name) : null,
      tokenType: installMeta?.token_type ? String(installMeta.token_type) : null,
      installedAt: installMeta?.installed_at ? String(installMeta.installed_at) : null,
      updatedAt: installMeta?.updated_at ? String(installMeta.updated_at) : null,
      botUserId: install.botUserId ?? null,
      botScope: installMeta?.bot_scope ? String(installMeta.bot_scope) : null,
      missingRecommendedScopes: missingScopes,
      authTest: {
        ok: Boolean(auth.ok),
        error: auth.error ?? null,
        teamId: auth.team_id ?? null,
        team: auth.team ?? null,
        botId: auth.bot_id ?? null,
        userId: auth.user_id ?? null
      }
    });
  }

  return {
    ok: true,
    installs: results
  };
}
