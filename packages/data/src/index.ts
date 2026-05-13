import type {
  AgentNoteRecord,
  IdentityAccountLink,
  NoteScopeType,
  NoteVisibility,
  PermissionWaiverRecord,
  PermissionWaiverStatus,
  PersonRecord,
  TaskActionType,
  TaskRecord,
  TaskStatus,
  UserRef
} from "@ask-thane/domain";

export interface TaskRepository {
  save(task: TaskRecord): Promise<void>;
  saveMany(tasks: TaskRecord[]): Promise<void>;
  listOpenByAssignee(workspaceId: string, assigneeId: string): Promise<TaskRecord[]>;
}

export interface IngestEventInput {
  id: string;
  organizationId: string;
  provider: string;
  providerEventId: string;
  providerMessageId?: string;
  conversationSourceId?: string;
  receivedAt: string;
}

export interface AclFilteredTaskReadInput {
  organizationId: string;
  assigneeId: string;
  readableConversationSourceIds: string[];
  allowUnscoped?: boolean;
}

export interface AclTaskSearchInput {
  organizationId: string;
  readableConversationSourceIds: string[];
  query?: string;
  assigneeId?: string;
  workspaceId?: string;
  statuses?: TaskStatus[];
  limit?: number;
  allowUnscoped?: boolean;
}

export interface AclTaskGetByIdInput {
  organizationId: string;
  taskId: string;
  readableConversationSourceIds: string[];
  allowUnscoped?: boolean;
}

export interface ResolvePersonForIdentityInput {
  organizationId: string;
  provider: UserRef["platform"];
  externalUserId: string;
  externalWorkspaceId?: string;
  displayName?: string;
  email?: string;
  linkedUserId?: string;
  confidence?: number;
  isVerified?: boolean;
  nowIso?: string;
}

export interface AgentNoteInput {
  id: string;
  organizationId: string;
  scopeType: NoteScopeType;
  scopeId: string;
  visibility: NoteVisibility;
  content: string;
  authorType: AgentNoteRecord["authorType"];
  authorId?: string;
  sourceConversationSourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AgentNoteQuery {
  organizationId: string;
  scopeType: NoteScopeType;
  scopeId: string;
  limit?: number;
}

export interface TaskActionInput {
  id: string;
  organizationId: string;
  workspaceId: string;
  actionType: TaskActionType;
  actorPlatform?: UserRef["platform"];
  actorId?: string;
  actorName?: string;
  sourceConversationSourceId?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  taskId?: string;
  targetTaskId?: string;
  status?: TaskStatus;
  title?: string;
  description?: string;
  dueAt?: string;
}

export interface PermissionWaiverRequestInput {
  id: string;
  organizationId: string;
  resourceType: string;
  resourceId: string;
  requesterUserId: string;
  requestedScopeType: NoteScopeType;
  requestedScopeId: string;
  requestReason?: string;
  requestedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PermissionWaiverDecisionInput {
  organizationId: string;
  waiverId: string;
  status: Extract<PermissionWaiverStatus, "granted" | "denied" | "revoked">;
  granterUserId: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
}

export class D1TaskRepository implements TaskRepository {
  constructor(private readonly db: D1Database) {}

  async save(task: TaskRecord): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (
         id, organization_id, workspace_id, channel_id, source_message_id, title, description,
         assignee_platform, assignee_id, assignee_name,
         assigner_platform, assigner_id, assigner_name,
         created_at, due_at, urgency, difficulty, status, confidence, metadata_json
       ) VALUES (?, (SELECT organization_id FROM workspaces WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    await stmt
      .bind(
        task.id,
        task.workspaceId,
        task.workspaceId,
        task.channelId ?? null,
        task.sourceMessageId ?? null,
        task.title,
        task.description ?? null,
        task.assignee.platform,
        task.assignee.platformUserId,
        task.assignee.displayName ?? null,
        task.assigner.platform,
        task.assigner.platformUserId,
        task.assigner.displayName ?? null,
        task.createdAt,
        task.dueAt ?? null,
        task.urgency,
        task.difficulty,
        task.status,
        task.confidence,
        JSON.stringify(task.metadata ?? {})
      )
      .run();
  }

  async saveMany(tasks: TaskRecord[]): Promise<void> {
    for (const task of tasks) {
      await this.save(task);
    }
  }

  async listOpenByAssignee(workspaceId: string, assigneeId: string): Promise<TaskRecord[]> {
    const query = this.db.prepare(
      `SELECT * FROM tasks WHERE workspace_id = ? AND assignee_id = ? AND status IN ('incomplete', 'in_progress', 'blocked') ORDER BY created_at DESC`
    );
    const result = await query.bind(workspaceId, assigneeId).all<Record<string, unknown>>();

    return (result.results ?? []).map((row) => toTaskRecord(row));
  }

  async recordIngestEvent(input: IngestEventInput): Promise<boolean> {
    const stmt = this.db.prepare(
      `INSERT INTO ingest_events (
         id, organization_id, provider, provider_event_id, provider_message_id, conversation_source_id, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, provider, provider_event_id) DO NOTHING`
    );

    const result = await stmt
      .bind(
        input.id,
        input.organizationId,
        input.provider,
        input.providerEventId,
        input.providerMessageId ?? null,
        input.conversationSourceId ?? null,
        input.receivedAt
      )
      .run();

    return Number(result.meta.changes ?? 0) > 0;
  }

  async markIngestEventProcessed(
    organizationId: string,
    provider: string,
    providerEventId: string,
    processedAt: string
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE ingest_events
         SET processed_at = ?
         WHERE organization_id = ? AND provider = ? AND provider_event_id = ?`
      )
      .bind(processedAt, organizationId, provider, providerEventId)
      .run();
  }

  async listOpenByAssigneeWithAcl(input: AclFilteredTaskReadInput): Promise<TaskRecord[]> {
    const readableConversationSourceIds = Array.from(new Set(input.readableConversationSourceIds));
    const allowUnscoped = Boolean(input.allowUnscoped);
    const placeholders = readableConversationSourceIds.map(() => "?").join(", ");
    const hasReadableScopes = readableConversationSourceIds.length > 0;

    const aclReadableCondition = hasReadableScopes
      ? `ra.conversation_source_id IS NULL OR ra.conversation_source_id IN (${placeholders})`
      : "ra.conversation_source_id IS NULL";

    const fallbackVisibilityParts: string[] = [];
    if (hasReadableScopes) {
      fallbackVisibilityParts.push(`t.primary_conversation_source_id IN (${placeholders})`);
    }
    if (allowUnscoped) {
      fallbackVisibilityParts.push("t.primary_conversation_source_id IS NULL");
    }
    const fallbackVisibility = fallbackVisibilityParts.length > 0 ? fallbackVisibilityParts.join(" OR ") : "0";

    const query = this.db.prepare(
      `SELECT t.*
       FROM tasks t
       WHERE t.organization_id = ?
         AND t.assignee_id = ?
         AND t.status IN ('incomplete', 'in_progress', 'blocked')
         AND (
           EXISTS (
             SELECT 1
             FROM resource_acl ra
             WHERE ra.organization_id = t.organization_id
               AND ra.resource_type = 'task'
               AND ra.resource_id = t.id
               AND (${aclReadableCondition})
           )
           OR (
             NOT EXISTS (
               SELECT 1
               FROM resource_acl ra2
               WHERE ra2.organization_id = t.organization_id
                 AND ra2.resource_type = 'task'
                 AND ra2.resource_id = t.id
             )
             AND (${fallbackVisibility})
           )
         )
       ORDER BY t.created_at DESC`
    );

    const bindings: Array<string> = [input.organizationId, input.assigneeId];
    if (hasReadableScopes) {
      bindings.push(...readableConversationSourceIds);
      bindings.push(...readableConversationSourceIds);
    }

    const result = await query.bind(...bindings).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => toTaskRecord(row));
  }

  async searchTasksWithAcl(input: AclTaskSearchInput): Promise<TaskRecord[]> {
    const readableConversationSourceIds = Array.from(new Set(input.readableConversationSourceIds));
    const allowUnscoped = Boolean(input.allowUnscoped);
    const hasReadableScopes = readableConversationSourceIds.length > 0;
    const scopePlaceholders = readableConversationSourceIds.map(() => "?").join(", ");

    const aclReadableCondition = hasReadableScopes
      ? `ra.conversation_source_id IS NULL OR ra.conversation_source_id IN (${scopePlaceholders})`
      : "ra.conversation_source_id IS NULL";

    const fallbackVisibilityParts: string[] = [];
    if (hasReadableScopes) {
      fallbackVisibilityParts.push(`t.primary_conversation_source_id IN (${scopePlaceholders})`);
    }
    if (allowUnscoped) {
      fallbackVisibilityParts.push("t.primary_conversation_source_id IS NULL");
    }
    const fallbackVisibility = fallbackVisibilityParts.length > 0 ? fallbackVisibilityParts.join(" OR ") : "0";

    const whereParts: string[] = [
      "t.organization_id = ?",
      `(
         EXISTS (
           SELECT 1
           FROM resource_acl ra
           WHERE ra.organization_id = t.organization_id
             AND ra.resource_type = 'task'
             AND ra.resource_id = t.id
             AND (${aclReadableCondition})
         )
         OR (
           NOT EXISTS (
             SELECT 1
             FROM resource_acl ra2
             WHERE ra2.organization_id = t.organization_id
               AND ra2.resource_type = 'task'
               AND ra2.resource_id = t.id
           )
           AND (${fallbackVisibility})
         )
       )`
    ];

    const bindings: Array<string | number> = [input.organizationId];
    if (hasReadableScopes) {
      bindings.push(...readableConversationSourceIds);
      bindings.push(...readableConversationSourceIds);
    }

    if (input.workspaceId) {
      whereParts.push("t.workspace_id = ?");
      bindings.push(input.workspaceId);
    }

    if (input.assigneeId) {
      whereParts.push("t.assignee_id = ?");
      bindings.push(input.assigneeId);
    }

    const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : null;
    if (statuses) {
      whereParts.push(`t.status IN (${statuses.map(() => "?").join(", ")})`);
      bindings.push(...statuses);
    }

    const query = input.query?.trim();
    if (query) {
      whereParts.push("(LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.description, '')) LIKE ?)");
      const like = `%${query.toLowerCase()}%`;
      bindings.push(like, like);
    }

    const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);
    bindings.push(limit);

    const sql = `SELECT t.*
       FROM tasks t
       WHERE ${whereParts.join("\n         AND ")}
       ORDER BY t.created_at DESC
       LIMIT ?`;

    const result = await this.db.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => toTaskRecord(row));
  }

  async getTaskByIdWithAcl(input: AclTaskGetByIdInput): Promise<TaskRecord | null> {
    const readableConversationSourceIds = Array.from(new Set(input.readableConversationSourceIds));
    const allowUnscoped = Boolean(input.allowUnscoped);
    const hasReadableScopes = readableConversationSourceIds.length > 0;
    const scopePlaceholders = readableConversationSourceIds.map(() => "?").join(", ");

    const aclReadableCondition = hasReadableScopes
      ? `ra.conversation_source_id IS NULL OR ra.conversation_source_id IN (${scopePlaceholders})`
      : "ra.conversation_source_id IS NULL";

    const fallbackVisibilityParts: string[] = [];
    if (hasReadableScopes) {
      fallbackVisibilityParts.push(`t.primary_conversation_source_id IN (${scopePlaceholders})`);
    }
    if (allowUnscoped) {
      fallbackVisibilityParts.push("t.primary_conversation_source_id IS NULL");
    }
    const fallbackVisibility = fallbackVisibilityParts.length > 0 ? fallbackVisibilityParts.join(" OR ") : "0";

    const sql = `SELECT t.*
      FROM tasks t
      WHERE t.organization_id = ?
        AND t.id = ?
        AND (
          EXISTS (
            SELECT 1
            FROM resource_acl ra
            WHERE ra.organization_id = t.organization_id
              AND ra.resource_type = 'task'
              AND ra.resource_id = t.id
              AND (${aclReadableCondition})
          )
          OR (
            NOT EXISTS (
              SELECT 1
              FROM resource_acl ra2
              WHERE ra2.organization_id = t.organization_id
                AND ra2.resource_type = 'task'
                AND ra2.resource_id = t.id
            )
            AND (${fallbackVisibility})
          )
        )
      LIMIT 1`;

    const bindings: Array<string> = [input.organizationId, input.taskId];
    if (hasReadableScopes) {
      bindings.push(...readableConversationSourceIds);
      bindings.push(...readableConversationSourceIds);
    }

    const row = await this.db.prepare(sql).bind(...bindings).first<Record<string, unknown>>();
    return row ? toTaskRecord(row) : null;
  }

  async resolveOrCreatePersonForIdentity(input: ResolvePersonForIdentityInput): Promise<PersonRecord> {
    const existing = await this.db
      .prepare(
        `SELECT p.id, p.organization_id, p.canonical_name, p.created_at, p.updated_at
         FROM identity_accounts ia
         JOIN people p ON p.id = ia.person_id
         WHERE ia.organization_id = ?
           AND ia.provider = ?
           AND ia.external_user_id = ?
           AND (ia.external_workspace_id IS ? OR ia.external_workspace_id = ?)
         LIMIT 1`
      )
      .bind(
        input.organizationId,
        input.provider,
        input.externalUserId,
        input.externalWorkspaceId ?? null,
        input.externalWorkspaceId ?? null
      )
      .first<Record<string, unknown>>();

    const nowIso = input.nowIso ?? new Date().toISOString();
    const canonicalName = input.displayName?.trim() || null;

    if (existing?.id) {
      await this.upsertIdentityAccount({
        ...input,
        personId: String(existing.id),
        nowIso
      });
      return toPersonRecord(existing);
    }

    const personId = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO people (
           id, organization_id, canonical_name, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(personId, input.organizationId, canonicalName, nowIso, nowIso)
      .run();

    await this.upsertIdentityAccount({
      ...input,
      personId,
      nowIso
    });

    const created: PersonRecord = {
      id: personId,
      organizationId: input.organizationId,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    if (canonicalName) {
      created.canonicalName = canonicalName;
    }

    return created;
  }

  async upsertIdentityAccount(input: ResolvePersonForIdentityInput & { personId: string; nowIso: string }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO identity_accounts (
           id, organization_id, person_id, provider, external_workspace_id, external_user_id,
           user_id, email, display_name, confidence, is_verified, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, provider, external_user_id, external_workspace_id)
         DO UPDATE SET
           person_id = excluded.person_id,
           user_id = excluded.user_id,
           email = excluded.email,
           display_name = excluded.display_name,
           confidence = excluded.confidence,
           is_verified = excluded.is_verified,
           updated_at = excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        input.organizationId,
        input.personId,
        input.provider,
        input.externalWorkspaceId ?? null,
        input.externalUserId,
        input.linkedUserId ?? null,
        input.email ?? null,
        input.displayName ?? null,
        clampConfidence(input.confidence),
        input.isVerified ? 1 : 0,
        input.nowIso,
        input.nowIso
      )
      .run();
  }

  async listIdentityAccountsForPerson(organizationId: string, personId: string): Promise<IdentityAccountLink[]> {
    const result = await this.db
      .prepare(
        `SELECT *
         FROM identity_accounts
         WHERE organization_id = ? AND person_id = ?
         ORDER BY updated_at DESC`
      )
      .bind(organizationId, personId)
      .all<Record<string, unknown>>();

    return (result.results ?? []).map((row) => toIdentityAccountLink(row));
  }

  async getPersonByUserId(organizationId: string, userId: string): Promise<PersonRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT p.*
         FROM people p
         JOIN identity_accounts ia ON ia.person_id = p.id
         WHERE p.organization_id = ?
           AND ia.organization_id = ?
           AND ia.user_id = ?
         ORDER BY ia.updated_at DESC
         LIMIT 1`
      )
      .bind(organizationId, organizationId, userId)
      .first<Record<string, unknown>>();

    return row ? toPersonRecord(row) : null;
  }

  async addAgentNote(input: AgentNoteInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_notes (
           id, organization_id, scope_type, scope_id, visibility, content,
           author_type, author_id, source_conversation_source_id, metadata_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.organizationId,
        input.scopeType,
        input.scopeId,
        input.visibility,
        input.content,
        input.authorType,
        input.authorId ?? null,
        input.sourceConversationSourceId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.createdAt,
        input.createdAt
      )
      .run();
  }

  async listAgentNotes(input: AgentNoteQuery): Promise<AgentNoteRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
    const result = await this.db
      .prepare(
        `SELECT *
         FROM agent_notes
         WHERE organization_id = ?
           AND scope_type = ?
           AND scope_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(input.organizationId, input.scopeType, input.scopeId, limit)
      .all<Record<string, unknown>>();

    return (result.results ?? []).map((row) => toAgentNoteRecord(row));
  }

  async performTaskAction(input: TaskActionInput): Promise<void> {
    const nowIso = input.createdAt;

    if (input.actionType === "create") {
      if (!input.taskId) {
        throw new Error("task_id_required_for_create_action");
      }
      await this.recordTaskAction({
        ...input,
        resultedStatus: "incomplete"
      });
      return;
    }

    if (!input.taskId) {
      throw new Error("task_id_required");
    }

    const task = await this.db
      .prepare(
        `SELECT id, status
         FROM tasks
         WHERE id = ? AND organization_id = ? AND workspace_id = ?
         LIMIT 1`
      )
      .bind(input.taskId, input.organizationId, input.workspaceId)
      .first<Record<string, unknown>>();

    if (!task?.id) {
      throw new Error("task_not_found");
    }

    if (input.actionType === "merge_into") {
      if (!input.targetTaskId) {
        throw new Error("target_task_id_required");
      }

      await this.db
        .prepare(
          `UPDATE tasks
           SET status = 'cancelled',
               archived_at = ?,
               metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.merged_into_task_id', ?)
           WHERE id = ? AND organization_id = ?`
        )
        .bind(nowIso, input.targetTaskId, input.taskId, input.organizationId)
        .run();

      await this.recordTaskAction({
        ...input,
        payload: {
          ...(input.payload ?? {}),
          target_task_id: input.targetTaskId
        },
        resultedStatus: "cancelled"
      });

      return;
    }

    if (input.actionType === "edit") {
      await this.db
        .prepare(
          `UPDATE tasks
           SET title = COALESCE(?, title),
               description = COALESCE(?, description),
               due_at = COALESCE(?, due_at)
           WHERE id = ? AND organization_id = ?`
        )
        .bind(input.title ?? null, input.description ?? null, input.dueAt ?? null, input.taskId, input.organizationId)
        .run();

      await this.recordTaskAction({
        ...input,
        resultedStatus: String(task.status) as TaskStatus
      });

      return;
    }

    const nextStatus = resolveStatusTransition(input.actionType, input.status);
    await this.db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END,
             archived_at = CASE WHEN ? IN ('cancelled') THEN ? ELSE archived_at END
         WHERE id = ? AND organization_id = ?`
      )
      .bind(nextStatus, nextStatus, nowIso, nextStatus, nowIso, input.taskId, input.organizationId)
      .run();

    await this.recordTaskAction({
      ...input,
      resultedStatus: nextStatus
    });
  }

  async requestPermissionWaiver(input: PermissionWaiverRequestInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO permission_waivers (
           id, organization_id, resource_type, resource_id, requester_user_id,
           granter_user_id, requested_scope_type, requested_scope_id, request_reason,
           status, requested_at, decided_at, expires_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, NULL, ?, ?)`
      )
      .bind(
        input.id,
        input.organizationId,
        input.resourceType,
        input.resourceId,
        input.requesterUserId,
        input.requestedScopeType,
        input.requestedScopeId,
        input.requestReason ?? null,
        input.requestedAt,
        input.expiresAt ?? null,
        JSON.stringify(input.metadata ?? {})
      )
      .run();
  }

  async decidePermissionWaiver(input: PermissionWaiverDecisionInput): Promise<void> {
    await this.db
      .prepare(
        `UPDATE permission_waivers
         SET status = ?,
             granter_user_id = ?,
             decided_at = ?,
             metadata_json = ?
         WHERE id = ? AND organization_id = ?`
      )
      .bind(
        input.status,
        input.granterUserId,
        input.decidedAt,
        JSON.stringify(input.metadata ?? {}),
        input.waiverId,
        input.organizationId
      )
      .run();
  }

  async listPendingPermissionWaivers(organizationId: string): Promise<PermissionWaiverRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT *
         FROM permission_waivers
         WHERE organization_id = ?
           AND status = 'pending'
         ORDER BY requested_at DESC`
      )
      .bind(organizationId)
      .all<Record<string, unknown>>();

    return (result.results ?? []).map((row) => toPermissionWaiverRecord(row));
  }

  private async recordTaskAction(input: TaskActionInput & { resultedStatus: TaskStatus }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO task_actions (
           id, organization_id, task_id, workspace_id, action_type,
           actor_platform, actor_id, actor_name, source_conversation_source_id,
           payload_json, resulted_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.organizationId,
        input.taskId,
        input.workspaceId,
        input.actionType,
        input.actorPlatform ?? null,
        input.actorId ?? null,
        input.actorName ?? null,
        input.sourceConversationSourceId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.resultedStatus,
        input.createdAt
      )
      .run();
  }
}

function resolveStatusTransition(actionType: TaskActionType, explicitStatus?: TaskStatus): TaskStatus {
  if (explicitStatus) {
    return explicitStatus;
  }

  switch (actionType) {
    case "mark_done":
      return "done";
    case "mark_cancelled":
      return "cancelled";
    case "mark_blocked":
      return "blocked";
    case "reopen":
      return "incomplete";
    case "create":
      return "incomplete";
    case "merge_into":
      return "cancelled";
    case "edit":
      return "incomplete";
    default:
      return "incomplete";
  }
}

function clampConfidence(value?: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
  const assignee: TaskRecord["assignee"] = {
    platform: String(row.assignee_platform) as TaskRecord["assignee"]["platform"],
    platformUserId: String(row.assignee_id)
  };
  if (row.assignee_name) {
    assignee.displayName = String(row.assignee_name);
  }

  const assigner: TaskRecord["assigner"] = {
    platform: String(row.assigner_platform) as TaskRecord["assigner"]["platform"],
    platformUserId: String(row.assigner_id)
  };
  if (row.assigner_name) {
    assigner.displayName = String(row.assigner_name);
  }

  const task: TaskRecord = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    assignee,
    assigner,
    createdAt: String(row.created_at),
    urgency: String(row.urgency) as TaskRecord["urgency"],
    difficulty: String(row.difficulty) as TaskRecord["difficulty"],
    status: String(row.status) as TaskRecord["status"],
    confidence: Number(row.confidence)
  };

  if (row.channel_id) {
    task.channelId = String(row.channel_id);
  }
  if (row.source_message_id) {
    task.sourceMessageId = String(row.source_message_id);
  }
  if (row.description) {
    task.description = String(row.description);
  }
  if (row.due_at) {
    task.dueAt = String(row.due_at);
  }
  if (row.metadata_json) {
    task.metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
  }

  return task;
}

function toPersonRecord(row: Record<string, unknown>): PersonRecord {
  const person: PersonRecord = {
    id: String(row.id),
    organizationId: String(row.organization_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (row.canonical_name) {
    person.canonicalName = String(row.canonical_name);
  }
  return person;
}

function toIdentityAccountLink(row: Record<string, unknown>): IdentityAccountLink {
  const link: IdentityAccountLink = {
    id: String(row.id),
    organizationId: String(row.organization_id),
    personId: String(row.person_id),
    provider: String(row.provider) as IdentityAccountLink["provider"],
    externalUserId: String(row.external_user_id),
    confidence: Number(row.confidence),
    isVerified: Number(row.is_verified) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };

  if (row.external_workspace_id) {
    link.externalWorkspaceId = String(row.external_workspace_id);
  }
  if (row.user_id) {
    link.userId = String(row.user_id);
  }
  if (row.email) {
    link.email = String(row.email);
  }
  if (row.display_name) {
    link.displayName = String(row.display_name);
  }

  return link;
}

function toAgentNoteRecord(row: Record<string, unknown>): AgentNoteRecord {
  const note: AgentNoteRecord = {
    id: String(row.id),
    organizationId: String(row.organization_id),
    scopeType: String(row.scope_type) as AgentNoteRecord["scopeType"],
    scopeId: String(row.scope_id),
    visibility: String(row.visibility) as AgentNoteRecord["visibility"],
    content: String(row.content),
    authorType: String(row.author_type) as AgentNoteRecord["authorType"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };

  if (row.author_id) {
    note.authorId = String(row.author_id);
  }
  if (row.source_conversation_source_id) {
    note.sourceConversationSourceId = String(row.source_conversation_source_id);
  }
  if (row.metadata_json) {
    note.metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
  }

  return note;
}

function toPermissionWaiverRecord(row: Record<string, unknown>): PermissionWaiverRecord {
  const waiver: PermissionWaiverRecord = {
    id: String(row.id),
    organizationId: String(row.organization_id),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    requesterUserId: String(row.requester_user_id),
    requestedScopeType: String(row.requested_scope_type) as PermissionWaiverRecord["requestedScopeType"],
    requestedScopeId: String(row.requested_scope_id),
    status: String(row.status) as PermissionWaiverRecord["status"],
    requestedAt: String(row.requested_at)
  };

  if (row.granter_user_id) {
    waiver.granterUserId = String(row.granter_user_id);
  }
  if (row.request_reason) {
    waiver.requestReason = String(row.request_reason);
  }
  if (row.decided_at) {
    waiver.decidedAt = String(row.decided_at);
  }
  if (row.expires_at) {
    waiver.expiresAt = String(row.expires_at);
  }
  if (row.metadata_json) {
    waiver.metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
  }

  return waiver;
}
