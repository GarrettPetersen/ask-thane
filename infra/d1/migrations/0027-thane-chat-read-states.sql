CREATE TABLE IF NOT EXISTS thane_cli_read_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(channel_id) REFERENCES thane_cli_channels(id),
  FOREIGN KEY(member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(workspace_id, channel_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_read_states_member
  ON thane_cli_read_states(member_id, workspace_id, channel_id);
