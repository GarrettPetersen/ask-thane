import type { TaskRecord } from "@ask-thane/domain";

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
    }
    if (hasReadableScopes) {
      bindings.push(...readableConversationSourceIds);
    }

    const result = await query.bind(...bindings).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => toTaskRecord(row));
  }
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
