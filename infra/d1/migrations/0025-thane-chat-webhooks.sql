CREATE TABLE IF NOT EXISTS thane_cli_webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '["message.created"]',
  signing_secret TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  bot_member_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_delivered_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(bot_member_id) REFERENCES thane_cli_workspace_members(id),
  FOREIGN KEY(created_by_member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_webhooks_workspace_status
  ON thane_cli_webhooks(workspace_id, status);
