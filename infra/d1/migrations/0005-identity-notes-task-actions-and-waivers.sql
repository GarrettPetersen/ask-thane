PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  canonical_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_people_org ON people(organization_id);

CREATE TABLE IF NOT EXISTS identity_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_workspace_id TEXT,
  external_user_id TEXT NOT NULL,
  user_id TEXT,
  email TEXT,
  display_name TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, provider, external_user_id, external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_org_person
  ON identity_accounts(organization_id, person_id);

CREATE TABLE IF NOT EXISTS agent_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('organization', 'workspace', 'conversation', 'person', 'user', 'task')),
  scope_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('private', 'organization', 'conversation_acl')),
  content TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('agent', 'system', 'user')),
  author_id TEXT,
  source_conversation_source_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_notes_scope
  ON agent_notes(organization_id, scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_actions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('create', 'mark_done', 'mark_cancelled', 'mark_blocked', 'reopen', 'merge_into', 'edit')),
  actor_platform TEXT,
  actor_id TEXT,
  actor_name TEXT,
  source_conversation_source_id TEXT,
  payload_json TEXT,
  resulted_status TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_actions_org_task_created
  ON task_actions(organization_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS permission_waivers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  granter_user_id TEXT,
  requested_scope_type TEXT NOT NULL CHECK(requested_scope_type IN ('organization', 'workspace', 'conversation', 'person', 'user', 'task')),
  requested_scope_id TEXT NOT NULL,
  request_reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'granted', 'denied', 'revoked', 'expired')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT,
  metadata_json TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granter_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_permission_waivers_org_resource
  ON permission_waivers(organization_id, resource_type, resource_id, status, requested_at DESC);
