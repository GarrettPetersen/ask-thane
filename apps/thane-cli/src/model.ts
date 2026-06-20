export type WorkspaceRole = "owner" | "admin" | "member";
export type ChannelVisibility = "public" | "private";
export type MessageSource = "chat" | "terminal" | "webhook";

export interface ThaneAccount {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  authToken?: string;
}

export interface ThaneWorkspaceMember {
  id: string;
  workspaceId: string;
  accountId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface AskThaneIntegration {
  workspaceId: string;
  enabled: boolean;
  botUserId: string;
  linkedAccountEmail: string;
  provider: "thane_cli";
  externalUserId: string;
  connectedAt: string;
  lastEventAt?: string;
}

export type PingLocation = "origin" | "thane_cli" | "slack" | "both";
export type ThaneCliPlanTier = "free" | "cli_team";
export type BillingStatus = "active" | "inactive" | "past_due";

export interface WorkspaceBillingPlan {
  workspaceId: string;
  planTier: ThaneCliPlanTier;
  status: BillingStatus;
  stripeCheckoutUrl?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  updatedAt: string;
}

export interface NotificationPreference {
  accountId: string;
  preferredPingLocation: PingLocation;
  updatedAt: string;
  updatedBy?: "user" | "ask_thane";
}

export interface PendingLogin {
  email: string;
  code: string;
  expiresAt: string;
  createdAt: string;
}

export interface ThaneUser {
  id: string;
  workspaceId: string;
  accountId?: string;
  handle: string;
  displayName: string;
  email?: string;
}

export interface ThaneWorkspace {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  asciiArt?: string;
}

export interface ThaneChannel {
  id: string;
  workspaceId: string;
  name: string;
  kind: "channel" | "dm";
  visibility: ChannelVisibility;
  memberIds: string[];
  topic?: string;
  createdAt: string;
}

export interface ThaneReaction {
  emoji: string;
  by: string;
  createdAt: string;
}

export interface ThaneMessage {
  id: string;
  workspaceId: string;
  channelId: string;
  authorId: string;
  text: string;
  createdAt: string;
  source?: MessageSource;
  threadRootId?: string;
  reactions: ThaneReaction[];
  mentions: string[];
}

export interface ThaneReadState {
  workspaceId: string;
  channelId: string;
  userId: string;
  lastReadAt: string;
}

export interface ThaneStoreData {
  currentAccountId?: string;
  accounts: ThaneAccount[];
  workspaceMembers: ThaneWorkspaceMember[];
  askThaneIntegrations: AskThaneIntegration[];
  notificationPreferences: NotificationPreference[];
  billingPlans: WorkspaceBillingPlan[];
  pendingLogins: PendingLogin[];
  activeWorkspaceId: string;
  workspaces: ThaneWorkspace[];
  currentUserId: string;
  users: ThaneUser[];
  channels: ThaneChannel[];
  messages: ThaneMessage[];
  readStates: ThaneReadState[];
}

export interface MessageView {
  id: string;
  workspace: string;
  channel: string;
  conversationKind: "channel" | "dm";
  author: string;
  text: string;
  createdAt: string;
  source?: MessageSource;
  threadRootId?: string;
  replyCount: number;
  reactions: ThaneReaction[];
  mentions: string[];
  mentionsMe: boolean;
}

export interface ConversationSummary {
  workspace: string;
  workspaceId: string;
  conversationId: string;
  conversation: string;
  conversationKind: "channel" | "dm";
  unreadCount: number;
  mentionCount: number;
  latestMessageAt?: string;
  latestAuthor?: string;
  latestText?: string;
}
