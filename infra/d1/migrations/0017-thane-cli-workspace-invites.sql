CREATE TABLE IF NOT EXISTS thane_cli_workspace_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_invites_workspace
  ON thane_cli_workspace_invites(workspace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_invites_expires
  ON thane_cli_workspace_invites(expires_at);
