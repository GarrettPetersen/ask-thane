export type TaskStatus = "incomplete" | "in_progress" | "blocked" | "done" | "cancelled";

export type TaskUrgency = "low" | "medium" | "high" | "critical";

export type TaskDifficulty = "low" | "medium" | "high";
export type TaskActionType =
  | "create"
  | "mark_done"
  | "mark_cancelled"
  | "mark_blocked"
  | "reopen"
  | "merge_into"
  | "edit";
export type NoteScopeType = "organization" | "workspace" | "conversation" | "person" | "user" | "task";
export type NoteVisibility = "private" | "organization" | "conversation_acl";
export type PermissionWaiverStatus = "pending" | "granted" | "denied" | "revoked" | "expired";

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

export interface PersonRecord {
  id: string;
  organizationId: string;
  canonicalName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityAccountLink {
  id: string;
  organizationId: string;
  personId: string;
  provider: UserRef["platform"];
  externalWorkspaceId?: string;
  externalUserId: string;
  userId?: string;
  email?: string;
  displayName?: string;
  confidence: number;
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentNoteRecord {
  id: string;
  organizationId: string;
  scopeType: NoteScopeType;
  scopeId: string;
  visibility: NoteVisibility;
  content: string;
  authorType: "agent" | "system" | "user";
  authorId?: string;
  sourceConversationSourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActionRecord {
  id: string;
  organizationId: string;
  taskId: string;
  workspaceId: string;
  actionType: TaskActionType;
  actorPlatform?: UserRef["platform"];
  actorId?: string;
  actorName?: string;
  sourceConversationSourceId?: string;
  payload?: Record<string, unknown>;
  resultedStatus?: TaskStatus;
  createdAt: string;
}

export interface PermissionWaiverRecord {
  id: string;
  organizationId: string;
  resourceType: string;
  resourceId: string;
  requesterUserId: string;
  granterUserId?: string;
  requestedScopeType: NoteScopeType;
  requestedScopeId: string;
  requestReason?: string;
  status: PermissionWaiverStatus;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface UserNotificationCadenceRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  platform: UserRef["platform"];
  externalUserId: string;
  isEnabled: boolean;
  timezone: string;
  cadenceJson: Record<string, unknown>;
  cadenceSummary?: string;
  nextDigestAt?: string;
  lastDigestAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DigestDeliveryRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  externalUserId: string;
  deliveryChannelId?: string;
  sourceMessageId?: string;
  taskCount: number;
  sentAt: string;
  metadata?: Record<string, unknown>;
}
