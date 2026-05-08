export type TaskStatus = "incomplete" | "in_progress" | "blocked" | "done" | "cancelled";

export type TaskUrgency = "low" | "medium" | "high" | "critical";

export type TaskDifficulty = "low" | "medium" | "high";

export interface UserRef {
  platform: "slack" | "teams" | "email" | "system";
  platformUserId: string;
  displayName?: string;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  channelId?: string;
  sourceMessageId?: string;
  title: string;
  description?: string;
  assignee: UserRef;
  assigner: UserRef;
  createdAt: string;
  dueAt?: string;
  urgency: TaskUrgency;
  difficulty: TaskDifficulty;
  status: TaskStatus;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface MessageEvent {
  workspaceId: string;
  channelId: string;
  messageId: string;
  text: string;
  author: UserRef;
  occurredAt: string;
}

export interface TaskExtractionResult {
  tasks: TaskRecord[];
  reasoningSummary: string;
}
