PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS slack_workspace_installs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_workspace_id TEXT NOT NULL,
  team_name TEXT,
  bot_token TEXT NOT NULL,
  bot_user_id TEXT,
  bot_scope TEXT,
  token_type TEXT,
  installed_by_external_user_id TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspace_id),
  UNIQUE(external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_workspace_installs_org_workspace
  ON slack_workspace_installs(organization_id, workspace_id);
