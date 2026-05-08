import type { TaskRecord } from "@ask-thane/domain";

export interface TaskRepository {
  save(task: TaskRecord): Promise<void>;
  saveMany(tasks: TaskRecord[]): Promise<void>;
  listOpenByAssignee(workspaceId: string, assigneeId: string): Promise<TaskRecord[]>;
}

export class D1TaskRepository implements TaskRepository {
  constructor(private readonly db: D1Database) {}

  async save(task: TaskRecord): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (
         id, workspace_id, channel_id, source_message_id, title, description,
         assignee_platform, assignee_id, assignee_name,
         assigner_platform, assigner_id, assigner_name,
         created_at, due_at, urgency, difficulty, status, confidence, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    await stmt
      .bind(
        task.id,
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

    return (result.results ?? []).map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      channelId: row.channel_id ? String(row.channel_id) : undefined,
      sourceMessageId: row.source_message_id ? String(row.source_message_id) : undefined,
      title: String(row.title),
      description: row.description ? String(row.description) : undefined,
      assignee: {
        platform: String(row.assignee_platform) as TaskRecord["assignee"]["platform"],
        platformUserId: String(row.assignee_id),
        displayName: row.assignee_name ? String(row.assignee_name) : undefined
      },
      assigner: {
        platform: String(row.assigner_platform) as TaskRecord["assigner"]["platform"],
        platformUserId: String(row.assigner_id),
        displayName: row.assigner_name ? String(row.assigner_name) : undefined
      },
      createdAt: String(row.created_at),
      dueAt: row.due_at ? String(row.due_at) : undefined,
      urgency: String(row.urgency) as TaskRecord["urgency"],
      difficulty: String(row.difficulty) as TaskRecord["difficulty"],
      status: String(row.status) as TaskRecord["status"],
      confidence: Number(row.confidence),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined
    }));
  }
}
