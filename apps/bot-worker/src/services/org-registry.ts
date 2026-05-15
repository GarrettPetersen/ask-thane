export interface SlackWorkspaceRef {
  organizationId: string;
  workspaceId: string;
  externalWorkspaceId: string;
}

type SlackExternalAccountType = "workspace" | "enterprise";

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export class OrgRegistry {
  constructor(private readonly db: D1Database) {}

  async resolveOrCreateSlackWorkspace(params: {
    externalWorkspaceId: string;
    defaultOrganizationId?: string;
    workspaceName?: string;
    externalOrganizationId?: string;
    organizationName?: string;
  }): Promise<SlackWorkspaceRef> {
    const nowIso = new Date().toISOString();
    const externalEnterpriseId = trimOrNull(params.externalOrganizationId);
    const externalAccountType: SlackExternalAccountType = externalEnterpriseId ? "enterprise" : "workspace";
    const externalAccountId = externalEnterpriseId ?? params.externalWorkspaceId;
    const organizationDisplayName =
      trimOrNull(params.organizationName) ??
      trimOrNull(params.workspaceName) ??
      (externalEnterpriseId ? `Slack Enterprise ${externalEnterpriseId}` : `Slack Workspace ${params.externalWorkspaceId}`);

    const existingWorkspace = await this.db
      .prepare(
        `SELECT id, organization_id
         FROM workspaces
         WHERE platform = 'slack' AND external_workspace_id = ?
         LIMIT 1`
      )
      .bind(params.externalWorkspaceId)
      .first<Record<string, unknown>>();

    if (existingWorkspace?.id && existingWorkspace.organization_id) {
      await this.upsertSlackExternalAccount({
        organizationId: String(existingWorkspace.organization_id),
        externalAccountType,
        externalAccountId,
        externalWorkspaceId: params.externalWorkspaceId,
        externalEnterpriseId,
        organizationDisplayName,
        nowIso
      });
      return {
        organizationId: String(existingWorkspace.organization_id),
        workspaceId: String(existingWorkspace.id),
        externalWorkspaceId: params.externalWorkspaceId
      };
    }

    const existingExternalAccount = await this.db
      .prepare(
        `SELECT organization_id
         FROM organization_external_accounts
         WHERE provider = 'slack'
           AND external_account_type = ?
           AND external_account_id = ?
         LIMIT 1`
      )
      .bind(externalAccountType, externalAccountId)
      .first<Record<string, unknown>>();

    const defaultOrganizationId = trimOrNull(params.defaultOrganizationId);
    const organizationId = existingExternalAccount?.organization_id
      ? String(existingExternalAccount.organization_id)
      : defaultOrganizationId ?? `org_${crypto.randomUUID().replace(/-/g, "")}`;

    await this.ensureOrganization({
      organizationId,
      organizationName: organizationDisplayName,
      nowIso
    });

    await this.upsertSlackExternalAccount({
      organizationId,
      externalAccountType,
      externalAccountId,
      externalWorkspaceId: params.externalWorkspaceId,
      externalEnterpriseId,
      organizationDisplayName,
      nowIso
    });

    const workspaceId = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO workspaces (
           id, organization_id, platform, external_workspace_id, name, plan_tier, created_at, updated_at
         ) VALUES (?, ?, 'slack', ?, ?, 'free', ?, ?)
         ON CONFLICT(platform, external_workspace_id)
         DO UPDATE SET
           organization_id = excluded.organization_id,
           name = excluded.name,
           updated_at = excluded.updated_at`
      )
      .bind(
        workspaceId,
        organizationId,
        params.externalWorkspaceId,
        params.workspaceName ?? `Slack ${params.externalWorkspaceId}`,
        nowIso,
        nowIso
      )
      .run();

    const resolvedWorkspace = await this.db
      .prepare(
        `SELECT id, organization_id
         FROM workspaces
         WHERE platform = 'slack' AND external_workspace_id = ?
         LIMIT 1`
      )
      .bind(params.externalWorkspaceId)
      .first<Record<string, unknown>>();

    if (!resolvedWorkspace?.id || !resolvedWorkspace.organization_id) {
      throw new Error("failed_to_resolve_workspace");
    }

    return {
      organizationId: String(resolvedWorkspace.organization_id),
      workspaceId: String(resolvedWorkspace.id),
      externalWorkspaceId: params.externalWorkspaceId
    };
  }

  private async ensureOrganization(params: {
    organizationId: string;
    organizationName: string;
    nowIso: string;
  }): Promise<void> {
    const existing = await this.db
      .prepare(
        `SELECT slug
         FROM organizations
         WHERE id = ?
         LIMIT 1`
      )
      .bind(params.organizationId)
      .first<Record<string, unknown>>();

    if (existing?.slug) {
      await this.db
        .prepare(
          `UPDATE organizations
           SET name = COALESCE(NULLIF(?, ''), name),
               updated_at = ?
           WHERE id = ?`
        )
        .bind(params.organizationName, params.nowIso, params.organizationId)
        .run();
      return;
    }

    const preferredBaseSlug = slugify(params.organizationName) || slugify(params.organizationId) || "organization";
    const slug = await this.allocateOrganizationSlug(preferredBaseSlug);

    await this.db
      .prepare(
        `INSERT INTO organizations (
           id, slug, name, billing_email, plan_tier, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 'free', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = COALESCE(NULLIF(excluded.name, ''), organizations.name),
           updated_at = excluded.updated_at`
      )
      .bind(params.organizationId, slug, params.organizationName, params.nowIso, params.nowIso)
      .run();
  }

  private async upsertSlackExternalAccount(params: {
    organizationId: string;
    externalAccountType: SlackExternalAccountType;
    externalAccountId: string;
    externalWorkspaceId: string;
    externalEnterpriseId: string | null;
    organizationDisplayName: string;
    nowIso: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO organization_external_accounts (
           id, organization_id, provider, external_account_type, external_account_id, display_name, metadata_json, created_at, updated_at
         ) VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, external_account_type, external_account_id)
         DO UPDATE SET
           organization_id = excluded.organization_id,
           display_name = COALESCE(excluded.display_name, organization_external_accounts.display_name),
           metadata_json = COALESCE(excluded.metadata_json, organization_external_accounts.metadata_json),
           updated_at = excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        params.organizationId,
        params.externalAccountType,
        params.externalAccountId,
        params.organizationDisplayName,
        JSON.stringify({
          external_workspace_id: params.externalWorkspaceId,
          external_enterprise_id: params.externalEnterpriseId
        }),
        params.nowIso,
        params.nowIso
      )
      .run();
  }

  private async allocateOrganizationSlug(baseSlug: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const row = await this.db
        .prepare(
          `SELECT id
           FROM organizations
           WHERE slug = ?
           LIMIT 1`
        )
        .bind(candidate)
        .first<Record<string, unknown>>();
      if (!row?.id) {
        return candidate;
      }
    }
    return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
  }
}
