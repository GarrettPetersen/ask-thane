export interface SlackWorkspaceInstallInput {
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
}

export interface SlackWorkspaceInstallRecord {
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
  botToken: string;
}

export class SlackInstallStore {
  constructor(private readonly db: D1Database) {}

  async upsertWorkspaceInstall(input: SlackWorkspaceInstallInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_workspace_installs (
           id, organization_id, workspace_id, external_workspace_id, team_name,
           bot_token, bot_user_id, bot_scope, token_type, installed_by_external_user_id,
           installed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id)
         DO UPDATE SET
           external_workspace_id = excluded.external_workspace_id,
           team_name = excluded.team_name,
           bot_token = excluded.bot_token,
           bot_user_id = excluded.bot_user_id,
           bot_scope = excluded.bot_scope,
           token_type = excluded.token_type,
           installed_by_external_user_id = excluded.installed_by_external_user_id,
           installed_at = excluded.installed_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        input.organizationId,
        input.workspaceId,
        input.externalWorkspaceId,
        input.teamName ?? null,
        input.botToken,
        input.botUserId ?? null,
        input.botScope ?? null,
        input.tokenType ?? null,
        input.installedByExternalUserId ?? null,
        input.installedAt,
        input.installedAt
      )
      .run();
  }

  async getBotTokenByExternalWorkspaceId(externalWorkspaceId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT bot_token
         FROM slack_workspace_installs
         WHERE external_workspace_id = ?
         LIMIT 1`
      )
      .bind(externalWorkspaceId)
      .first<Record<string, unknown>>();

    return row?.bot_token ? String(row.bot_token) : null;
  }

  async listWorkspaceInstalls(): Promise<SlackWorkspaceInstallRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT organization_id, workspace_id, external_workspace_id, bot_token
         FROM slack_workspace_installs`
      )
      .all<Record<string, unknown>>();

    return (result.results ?? []).map((row) => ({
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      externalWorkspaceId: String(row.external_workspace_id),
      botToken: String(row.bot_token)
    }));
  }
}
