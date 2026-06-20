ALTER TABLE thane_cli_workspace_members ADD COLUMN left_at TEXT;

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_members_active
  ON thane_cli_workspace_members(workspace_id, left_at);
