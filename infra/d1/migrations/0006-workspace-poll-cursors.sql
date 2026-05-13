PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_poll_cursors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  cursor_key TEXT NOT NULL,
  last_cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(organization_id, workspace_id, provider, cursor_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_poll_cursors_org_workspace
  ON workspace_poll_cursors(organization_id, workspace_id, provider);
