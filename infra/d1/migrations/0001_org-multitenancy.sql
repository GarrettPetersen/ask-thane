PRAGMA foreign_keys = ON;

-- 1) Introduce organization as the security and billing boundary.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  billing_email TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Legacy/default org for existing prototype rows.
INSERT INTO organizations (id, slug, name, plan_tier, created_at, updated_at)
VALUES ('org_legacy', 'legacy-org', 'Legacy Organization', 'free', datetime('now'), datetime('now'))
ON CONFLICT(id) DO NOTHING;

-- 2) Add org scope to existing tables.
ALTER TABLE workspaces ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_legacy';
ALTER TABLE users ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_legacy';
ALTER TABLE tasks ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_legacy';
ALTER TABLE task_events ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_legacy';
ALTER TABLE reminders ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_legacy';

-- 3) Add indexes for org-first query patterns.
CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_org_workspace ON users(organization_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee_status ON tasks(organization_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_source_message ON tasks(organization_id, source_message_id);
CREATE INDEX IF NOT EXISTS idx_task_events_org_task_created ON task_events(organization_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reminders_org_sent ON reminders(organization_id, sent_at);

-- 4) Add org membership and cross-platform identity mapping.
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
