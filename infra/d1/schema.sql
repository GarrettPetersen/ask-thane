PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  billing_email TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_workspace_id TEXT NOT NULL,
  name TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(platform, external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(organization_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspace_id, platform, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_users_org_workspace ON users(organization_id, workspace_id);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_org_role ON memberships(organization_id, role);

CREATE TABLE IF NOT EXISTS conversation_sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_conversation_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  visibility_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(organization_id, provider, provider_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_sources_org_workspace
  ON conversation_sources(organization_id, workspace_id);

CREATE TABLE IF NOT EXISTS conversation_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  version TEXT,
  synced_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(conversation_source_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_memberships_org_user_active
  ON conversation_memberships(organization_id, user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_conversation_memberships_conversation_active
  ON conversation_memberships(conversation_source_id, is_active);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  primary_conversation_source_id TEXT,
  channel_id TEXT,
  source_message_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  assignee_platform TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  assignee_name TEXT,
  assigner_platform TEXT NOT NULL,
  assigner_id TEXT NOT NULL,
  assigner_name TEXT,
  created_at TEXT NOT NULL,
  due_at TEXT,
  urgency TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  metadata_json TEXT,
  completed_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (primary_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_org_status ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee_status ON tasks(organization_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_source_message ON tasks(organization_id, source_message_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_primary_conversation ON tasks(organization_id, primary_conversation_source_id);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_source_id TEXT,
  event_type TEXT NOT NULL,
  actor_platform TEXT,
  actor_id TEXT,
  actor_name TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_org_task_created ON task_events(organization_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_org_conversation ON task_events(organization_id, conversation_source_id);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_task_event_id TEXT,
  recipient_platform TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  delivery_channel_id TEXT,
  sent_at TEXT NOT NULL,
  response_message_id TEXT,
  response_state TEXT,
  metadata_json TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_task_event_id) REFERENCES task_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_org_sent ON reminders(organization_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_reminders_org_source_task_event ON reminders(organization_id, source_task_event_id);

CREATE TABLE IF NOT EXISTS resource_acl (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  conversation_source_id TEXT,
  acl_mode TEXT NOT NULL CHECK(acl_mode IN ('inherit', 'intersection', 'restricted')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE CASCADE,
  UNIQUE(organization_id, resource_type, resource_id, conversation_source_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_acl_org_resource
  ON resource_acl(organization_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_acl_org_conversation
  ON resource_acl(organization_id, conversation_source_id);

CREATE TABLE IF NOT EXISTS ingest_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_message_id TEXT,
  conversation_source_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL,
  UNIQUE(organization_id, provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_ingest_events_org_provider_message
  ON ingest_events(organization_id, provider, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_ingest_events_org_conversation
  ON ingest_events(organization_id, conversation_source_id);

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT,
  user_id TEXT,
  provider TEXT NOT NULL,
  external_workspace_id TEXT,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, provider, external_user_id, external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_org_user ON external_identities(organization_id, user_id);
