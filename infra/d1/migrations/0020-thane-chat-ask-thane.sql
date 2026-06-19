CREATE TABLE IF NOT EXISTS thane_cli_ask_thane_integrations (
  workspace_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  bot_member_id TEXT,
  linked_account_email TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(bot_member_id) REFERENCES thane_cli_workspace_members(id)
);
