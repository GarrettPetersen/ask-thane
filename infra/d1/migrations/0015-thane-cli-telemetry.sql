CREATE TABLE IF NOT EXISTS thane_cli_workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  workspace_slug TEXT NOT NULL,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK(plan_tier IN ('free', 'cli_team')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspaces_created_at
  ON thane_cli_workspaces(created_at);

CREATE TABLE IF NOT EXISTS thane_cli_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_accounts_created_at
  ON thane_cli_accounts(created_at);

CREATE INDEX IF NOT EXISTS idx_thane_cli_accounts_workspace
  ON thane_cli_accounts(workspace_id);

CREATE TABLE IF NOT EXISTS thane_cli_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT,
  author_account_id TEXT,
  message_kind TEXT NOT NULL DEFAULT 'message',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(author_account_id) REFERENCES thane_cli_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_messages_created_at
  ON thane_cli_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_thane_cli_messages_workspace
  ON thane_cli_messages(workspace_id);
