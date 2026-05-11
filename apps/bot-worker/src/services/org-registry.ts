export interface SlackWorkspaceRef {
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
}

export class OrgRegistry {
  constructor(private readonly db: D1Database) {}

  async resolveOrCreateSlackWorkspace(params: {
    externalWorkspaceId: string;
    defaultOrganizationId?: string;
  }): Promise<SlackWorkspaceRef> {
    const defaultOrganizationId = params.defaultOrganizationId ?? "org_0";
    const nowIso = new Date().toISOString();

    await this.ensureOrganization({
      organizationId: defaultOrganizationId,
      nowIso
    });

    const workspaceId = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO workspaces (
           id, organization_id, platform, external_workspace_id, name, plan_tier, created_at, updated_at
         ) VALUES (?, ?, 'slack', ?, ?, 'free', ?, ?)
         ON CONFLICT(platform, external_workspace_id) DO NOTHING`
      )
      .bind(
        workspaceId,
        defaultOrganizationId,
        params.externalWorkspaceId,
        `Slack ${params.externalWorkspaceId}`,
        nowIso,
        nowIso
      )
      .run();

    const existing = await this.db
      .prepare(
        `SELECT id, organization_id
         FROM workspaces
         WHERE platform = 'slack' AND external_workspace_id = ?
         LIMIT 1`
      )
      .bind(params.externalWorkspaceId)
      .first<Record<string, unknown>>();
    if (!existing?.id || !existing.organization_id) {
      throw new Error("failed_to_resolve_workspace");
    }

    return {
      organizationId: String(existing.organization_id),
      workspaceId: String(existing.id),
      externalWorkspaceId: params.externalWorkspaceId
    };
  }

  private async ensureOrganization(params: {
    organizationId: string;
    nowIso: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO organizations (
           id, slug, name, billing_email, plan_tier, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 'free_forever', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at`
      )
      .bind(
        params.organizationId,
        params.organizationId.replace(/_/g, "-"),
        "Thane Test Organization",
        params.nowIso,
        params.nowIso
      )
      .run();
  }
}
