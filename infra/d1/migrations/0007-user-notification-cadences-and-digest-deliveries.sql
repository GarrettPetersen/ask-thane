PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_notification_cadences (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  cadence_json TEXT NOT NULL,
  cadence_summary TEXT,
  next_digest_at TEXT,
  last_digest_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(organization_id, workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_cadences_due
  ON user_notification_cadences(organization_id, workspace_id, is_enabled, next_digest_at);

CREATE TABLE IF NOT EXISTS digest_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  delivery_channel_id TEXT,
  source_message_id TEXT,
  task_count INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_deliveries_user_sent
  ON digest_deliveries(organization_id, workspace_id, user_id, sent_at DESC);
