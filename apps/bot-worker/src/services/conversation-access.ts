import type { SlackMembershipEvent } from "@ask-thane/integrations";

interface ConversationSourceRef {
  id: string;
  conversationKind: string;
  isPublic: boolean;
}

export interface ReadableConversationSource {
  id: string;
  workspaceId: string;
  providerConversationId: string;
  conversationKind: string;
  isPublic: boolean;
}

export interface ActiveSlackConversationParticipant {
  externalUserId: string;
  displayName?: string;
}

export class ConversationAccessResolver {
  constructor(private readonly db: D1Database) {}

  async listActiveSlackConversationExternalUsers(params: {
    organizationId: string;
    conversationSourceId: string;
  }): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT u.external_user_id
         FROM conversation_memberships cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.organization_id = ?
           AND cm.conversation_source_id = ?
           AND cm.is_active = 1
           AND u.platform = 'slack'
         ORDER BY cm.synced_at DESC`
      )
      .bind(params.organizationId, params.conversationSourceId)
      .all<Record<string, unknown>>();

    const ids = new Set<string>();
    for (const row of result.results ?? []) {
      const externalUserId = row.external_user_id ? String(row.external_user_id).trim() : "";
      if (externalUserId) {
        ids.add(externalUserId);
      }
    }
    return Array.from(ids);
  }

  async listActiveSlackConversationParticipants(params: {
    organizationId: string;
    conversationSourceId: string;
  }): Promise<ActiveSlackConversationParticipant[]> {
    const result = await this.db
      .prepare(
        `SELECT u.external_user_id, u.display_name
         FROM conversation_memberships cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.organization_id = ?
           AND cm.conversation_source_id = ?
           AND cm.is_active = 1
           AND u.platform = 'slack'
         ORDER BY cm.synced_at DESC`
      )
      .bind(params.organizationId, params.conversationSourceId)
      .all<Record<string, unknown>>();

    const seen = new Set<string>();
    const participants: ActiveSlackConversationParticipant[] = [];
    for (const row of result.results ?? []) {
      const externalUserId = row.external_user_id ? String(row.external_user_id).trim() : "";
      if (!externalUserId || seen.has(externalUserId)) {
        continue;
      }
      seen.add(externalUserId);
      const displayName = row.display_name ? String(row.display_name).trim() : "";
      participants.push({
        externalUserId,
        ...(displayName ? { displayName } : {})
      });
    }
    return participants;
  }

  async upsertSlackConversationSource(params: {
    organizationId: string;
    workspaceId: string;
    channelId: string;
    conversationKind: string;
    isPublic: boolean;
    nowIso?: string;
  }): Promise<ConversationSourceRef> {
    const nowIso = params.nowIso ?? new Date().toISOString();

    const insert = this.db.prepare(
      `INSERT INTO conversation_sources (
         id, organization_id, workspace_id, provider, provider_conversation_id,
         conversation_kind, is_public, visibility_version, created_at, updated_at
       ) VALUES (?, ?, ?, 'slack', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, provider, provider_conversation_id)
       DO UPDATE SET
         conversation_kind = excluded.conversation_kind,
         is_public = excluded.is_public,
         visibility_version = excluded.visibility_version,
         updated_at = excluded.updated_at`
    );

    await insert
      .bind(
        crypto.randomUUID(),
        params.organizationId,
        params.workspaceId,
        params.channelId,
        params.conversationKind,
        params.isPublic ? 1 : 0,
        nowIso,
        nowIso,
        nowIso
      )
      .run();

    const query = this.db.prepare(
      `SELECT id, conversation_kind, is_public
       FROM conversation_sources
       WHERE organization_id = ? AND provider = 'slack' AND provider_conversation_id = ?`
    );

    const row = await query.bind(params.organizationId, params.channelId).first<Record<string, unknown>>();
    if (!row) {
      throw new Error("failed_to_resolve_conversation_source");
    }

    return {
      id: String(row.id),
      conversationKind: String(row.conversation_kind),
      isPublic: Number(row.is_public) === 1
    };
  }

  async applySlackMembershipEvent(params: {
    organizationId: string;
    workspaceId: string;
    event: SlackMembershipEvent;
  }): Promise<void> {
    const nowIso = params.event.occurredAt;
    const source = await this.upsertSlackConversationSource({
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      channelId: params.event.channelId,
      conversationKind: params.event.conversationKind,
      isPublic: params.event.isPublic,
      nowIso
    });

    const user = await this.ensureSlackUser({
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      platformUserId: params.event.userId,
      nowIso
    });

    await this.upsertConversationMembership({
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      conversationSourceId: source.id,
      userId: user.userId,
      isActive: params.event.action === "joined",
      syncedAt: nowIso,
      version: nowIso
    });
  }

  async listReadableConversationSourceIds(params: {
    organizationId: string;
    userId: string;
  }): Promise<string[]> {
    const query = this.db.prepare(
      `SELECT DISTINCT cs.id
       FROM conversation_sources cs
       LEFT JOIN conversation_memberships cm
         ON cm.conversation_source_id = cs.id
        AND cm.user_id = ?
        AND cm.is_active = 1
       WHERE cs.organization_id = ?
         AND (
           cs.is_public = 1
           OR cm.id IS NOT NULL
         )`
    );

    const result = await query.bind(params.userId, params.organizationId).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => String(row.id));
  }

  async listReadableConversationSources(params: {
    organizationId: string;
    userId: string;
    limit?: number;
  }): Promise<ReadableConversationSource[]> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 250);
    const query = this.db.prepare(
      `SELECT DISTINCT
         cs.id,
         cs.workspace_id,
         cs.provider_conversation_id,
         cs.conversation_kind,
         cs.is_public
       FROM conversation_sources cs
       LEFT JOIN conversation_memberships cm
         ON cm.conversation_source_id = cs.id
        AND cm.user_id = ?
        AND cm.is_active = 1
       WHERE cs.organization_id = ?
         AND (
           cs.is_public = 1
           OR cm.id IS NOT NULL
         )
       ORDER BY cs.updated_at DESC
       LIMIT ?`
    );

    const result = await query.bind(params.userId, params.organizationId, limit).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      providerConversationId: String(row.provider_conversation_id),
      conversationKind: String(row.conversation_kind),
      isPublic: Number(row.is_public) === 1
    }));
  }

  async getConversationSourceById(params: {
    organizationId: string;
    conversationSourceId: string;
  }): Promise<ReadableConversationSource | null> {
    const row = await this.db
      .prepare(
        `SELECT id, workspace_id, provider_conversation_id, conversation_kind, is_public
         FROM conversation_sources
         WHERE organization_id = ? AND id = ?
         LIMIT 1`
      )
      .bind(params.organizationId, params.conversationSourceId)
      .first<Record<string, unknown>>();

    if (!row?.id) {
      return null;
    }

    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      providerConversationId: String(row.provider_conversation_id),
      conversationKind: String(row.conversation_kind),
      isPublic: Number(row.is_public) === 1
    };
  }

  async resolveInternalUserId(params: {
    organizationId: string;
    workspaceId: string;
    platform: "slack";
    platformUserId: string;
  }): Promise<string | null> {
    const query = this.db.prepare(
      `SELECT id
       FROM users
       WHERE organization_id = ?
         AND workspace_id = ?
         AND platform = ?
         AND external_user_id = ?
       LIMIT 1`
    );

    const row = await query
      .bind(params.organizationId, params.workspaceId, params.platform, params.platformUserId)
      .first<Record<string, unknown>>();

    return row?.id ? String(row.id) : null;
  }

  async reconcileSlackConversationMemberships(params: {
    organizationId: string;
    workspaceId: string;
    botToken: string;
    nowIso?: string;
    maxConversations?: number;
  }): Promise<{ conversationsChecked: number; membershipsUpserted: number }> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const maxConversations = params.maxConversations ?? 100;
    const profileCache = new Map<string, { displayName?: string; email?: string }>();

    const sourcesResult = await this.db
      .prepare(
        `SELECT id, provider_conversation_id
         FROM conversation_sources
         WHERE organization_id = ?
           AND workspace_id = ?
           AND provider = 'slack'
           AND conversation_kind IN ('public_channel', 'private_channel')
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .bind(params.organizationId, params.workspaceId, maxConversations)
      .all<Record<string, unknown>>();

    let membershipsUpserted = 0;
    const sources = (sourcesResult.results ?? []).map((row) => ({
      id: String(row.id),
      providerConversationId: String(row.provider_conversation_id)
    }));

    for (const source of sources) {
      const memberPlatformIds = await this.fetchSlackConversationMembers(source.providerConversationId, params.botToken);
      const memberUserIds = new Set<string>();

      for (const platformUserId of memberPlatformIds) {
        let profile = profileCache.get(platformUserId);
        if (!profile) {
          try {
            profile = await this.fetchSlackUserProfile(platformUserId, params.botToken);
          } catch {
            profile = {};
          }
          profileCache.set(platformUserId, profile);
        }
        const user = await this.ensureSlackUser({
          organizationId: params.organizationId,
          workspaceId: params.workspaceId,
          platformUserId,
          nowIso,
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.email ? { email: profile.email } : {})
        });
        memberUserIds.add(user.userId);
        await this.upsertConversationMembership({
          organizationId: params.organizationId,
          workspaceId: params.workspaceId,
          conversationSourceId: source.id,
          userId: user.userId,
          isActive: true,
          syncedAt: nowIso,
          version: nowIso
        });
        membershipsUpserted += 1;
      }

      await this.deactivateMissingConversationMembers({
        conversationSourceId: source.id,
        syncedAt: nowIso,
        userIdsToKeep: Array.from(memberUserIds)
      });
    }

    return {
      conversationsChecked: sources.length,
      membershipsUpserted
    };
  }

  async listSlackWorkspaces(): Promise<Array<{ organizationId: string; workspaceId: string; externalWorkspaceId: string }>> {
    const result = await this.db
      .prepare(
        `SELECT organization_id, id, external_workspace_id
         FROM workspaces
         WHERE platform = 'slack'`
      )
      .all<Record<string, unknown>>();

    return (result.results ?? []).map((row) => ({
      organizationId: String(row.organization_id),
      workspaceId: String(row.id),
      externalWorkspaceId: String(row.external_workspace_id)
    }));
  }

  async ensureSlackUser(params: {
    organizationId: string;
    workspaceId: string;
    platformUserId: string;
    nowIso: string;
    displayName?: string;
    email?: string;
  }): Promise<{ userId: string }> {
    const existingId = await this.resolveInternalUserId({
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      platform: "slack",
      platformUserId: params.platformUserId
    });

    if (existingId) {
      if (params.displayName || params.email) {
        await this.db
          .prepare(
            `UPDATE users
             SET display_name = COALESCE(?, display_name),
                 email = COALESCE(?, email),
                 updated_at = ?
             WHERE id = ?`
          )
          .bind(params.displayName ?? null, params.email ?? null, params.nowIso, existingId)
          .run();
      }
      return { userId: existingId };
    }

    const userId = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO users (
           id, organization_id, workspace_id, platform, external_user_id,
           display_name, email, role, created_at, updated_at
         ) VALUES (?, ?, ?, 'slack', ?, ?, ?, 'member', ?, ?)`
      )
      .bind(
        userId,
        params.organizationId,
        params.workspaceId,
        params.platformUserId,
        params.displayName ?? null,
        params.email ?? null,
        params.nowIso,
        params.nowIso
      )
      .run();

    return { userId };
  }

  async ensureSlackConversationMembership(params: {
    organizationId: string;
    workspaceId: string;
    conversationSourceId: string;
    platformUserId: string;
    nowIso: string;
  }): Promise<{ userId: string }> {
    const user = await this.ensureSlackUser({
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      platformUserId: params.platformUserId,
      nowIso: params.nowIso
    });

    await this.upsertConversationMembership({
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      conversationSourceId: params.conversationSourceId,
      userId: user.userId,
      isActive: true,
      syncedAt: params.nowIso,
      version: params.nowIso
    });

    return user;
  }

  private async upsertConversationMembership(params: {
    organizationId: string;
    workspaceId: string;
    conversationSourceId: string;
    userId: string;
    isActive: boolean;
    syncedAt: string;
    version: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO conversation_memberships (
           id, organization_id, workspace_id, conversation_source_id, user_id,
           role, is_active, version, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_source_id, user_id)
         DO UPDATE SET
           is_active = excluded.is_active,
           version = excluded.version,
           synced_at = excluded.synced_at`
      )
      .bind(
        crypto.randomUUID(),
        params.organizationId,
        params.workspaceId,
        params.conversationSourceId,
        params.userId,
        null,
        params.isActive ? 1 : 0,
        params.version,
        params.syncedAt
      )
      .run();
  }

  private async deactivateMissingConversationMembers(params: {
    conversationSourceId: string;
    syncedAt: string;
    userIdsToKeep: string[];
  }): Promise<void> {
    if (params.userIdsToKeep.length === 0) {
      await this.db
        .prepare(
          `UPDATE conversation_memberships
           SET is_active = 0, synced_at = ?
           WHERE conversation_source_id = ?`
        )
        .bind(params.syncedAt, params.conversationSourceId)
        .run();
      return;
    }

    const placeholders = params.userIdsToKeep.map(() => "?").join(", ");
    await this.db
      .prepare(
        `UPDATE conversation_memberships
         SET is_active = 0, synced_at = ?
         WHERE conversation_source_id = ?
           AND user_id NOT IN (${placeholders})`
      )
      .bind(params.syncedAt, params.conversationSourceId, ...params.userIdsToKeep)
      .run();
  }

  private async fetchSlackConversationMembers(conversationId: string, botToken: string): Promise<string[]> {
    const members = new Set<string>();
    let cursor: string | null = null;

    do {
      const params = new URLSearchParams({ channel: conversationId, limit: "1000" });
      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await fetch(`https://slack.com/api/conversations.members?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${botToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`slack_members_fetch_failed:${response.status}`);
      }

      const payload = (await response.json()) as {
        ok?: boolean;
        members?: string[];
        error?: string;
        response_metadata?: { next_cursor?: string };
      };

      if (!payload.ok) {
        throw new Error(`slack_members_error:${payload.error ?? "unknown"}`);
      }

      for (const member of payload.members ?? []) {
        members.add(member);
      }

      cursor = payload.response_metadata?.next_cursor?.trim() || null;
    } while (cursor);

    return Array.from(members);
  }

  private async fetchSlackUserProfile(
    platformUserId: string,
    botToken: string
  ): Promise<{ displayName?: string; email?: string }> {
    const params = new URLSearchParams({ user: platformUserId });
    const response = await fetch(`https://slack.com/api/users.info?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${botToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`slack_user_info_fetch_failed:${response.status}`);
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      user?: {
        profile?: {
          display_name?: string;
          real_name?: string;
          email?: string;
        };
        name?: string;
      };
    };
    if (!payload.ok) {
      throw new Error(`slack_user_info_error:${payload.error ?? "unknown"}`);
    }

    const displayName =
      payload.user?.profile?.display_name?.trim() ||
      payload.user?.profile?.real_name?.trim() ||
      payload.user?.name?.trim() ||
      undefined;
    const email = payload.user?.profile?.email?.trim() || undefined;

    return {
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {})
    };
  }
}
