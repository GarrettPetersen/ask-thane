ALTER TABLE thane_cli_channel_members ADD COLUMN left_at TEXT;

CREATE INDEX IF NOT EXISTS idx_thane_cli_channel_members_active
  ON thane_cli_channel_members(channel_id, member_id, left_at);

CREATE TABLE IF NOT EXISTS thane_cli_workspace_bans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  banned_by_member_id TEXT NOT NULL,
  reason TEXT,
  banned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(banned_by_member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(workspace_id, email)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_bans_email
  ON thane_cli_workspace_bans(email, workspace_id);
