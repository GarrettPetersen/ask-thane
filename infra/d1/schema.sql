PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_workspace_id TEXT NOT NULL,
  name TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, external_workspace_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspace_id, platform, external_user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT,
  source_message_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  assignee_platform TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  assignee_name TEXT,
  assigner_platform TEXT NOT NULL,
  assigner_id TEXT NOT NULL,
  assigner_name TEXT,
  created_at TEXT NOT NULL,
  due_at TEXT,
  urgency TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  metadata_json TEXT,
  completed_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(workspace_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_source_message ON tasks(workspace_id, source_message_id);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_platform TEXT,
  actor_id TEXT,
  actor_name TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  recipient_platform TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  delivery_channel_id TEXT,
  sent_at TEXT NOT NULL,
  response_message_id TEXT,
  response_state TEXT,
  metadata_json TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_workspace_sent ON reminders(workspace_id, sent_at);
