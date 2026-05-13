PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS follow_up_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  source_conversation_source_id TEXT,
  schedule_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed', 'cancelled')),
  prompt TEXT NOT NULL,
  context_json TEXT,
  message_channel_id TEXT,
  message_ts TEXT,
  response_text TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  last_attempt_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_follow_up_jobs_due
  ON follow_up_jobs(status, schedule_at);

CREATE INDEX IF NOT EXISTS idx_follow_up_jobs_user_created
  ON follow_up_jobs(organization_id, workspace_id, user_id, created_at DESC);
