PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS task_feedback (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_source_id TEXT,
  source_message_id TEXT,
  task_id TEXT,
  feedback_type TEXT NOT NULL CHECK(feedback_type IN ('not_a_task', 'wrong_assignee', 'wrong_status', 'wrong_priority', 'other')),
  details_json TEXT,
  actor_platform TEXT,
  actor_id TEXT,
  actor_user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_feedback_org_created
  ON task_feedback(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS llm_usage_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  request_type TEXT,
  source TEXT,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_events_org_created
  ON llm_usage_events(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_daily_aggregates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT,
  usage_date TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  source_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  UNIQUE(organization_id, workspace_id, usage_date, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_aggregates_org_date
  ON usage_daily_aggregates(organization_id, usage_date);
