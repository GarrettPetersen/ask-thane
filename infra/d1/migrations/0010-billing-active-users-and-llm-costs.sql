PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS billing_workspace_settings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  included_active_users INTEGER,
  hard_cap_active_users INTEGER,
  active_user_window_days INTEGER NOT NULL DEFAULT 30,
  overage_enabled INTEGER NOT NULL DEFAULT 1,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(organization_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_workspace_settings_workspace
  ON billing_workspace_settings(organization_id, workspace_id);

CREATE TABLE IF NOT EXISTS workspace_user_activity (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  external_user_id TEXT NOT NULL,
  first_activity_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_event_type TEXT,
  last_conversation_source_id TEXT,
  last_source_message_id TEXT,
  is_billable INTEGER NOT NULL DEFAULT 1,
  is_deactivated INTEGER NOT NULL DEFAULT 0,
  deactivated_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (last_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL,
  UNIQUE(organization_id, workspace_id, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_activity_active
  ON workspace_user_activity(organization_id, workspace_id, is_billable, is_deactivated, last_activity_at);

CREATE INDEX IF NOT EXISTS idx_workspace_user_activity_user
  ON workspace_user_activity(organization_id, workspace_id, user_id);

ALTER TABLE llm_usage_events ADD COLUMN prompt_cost_usd REAL;
ALTER TABLE llm_usage_events ADD COLUMN completion_cost_usd REAL;
ALTER TABLE llm_usage_events ADD COLUMN total_cost_usd REAL;
ALTER TABLE llm_usage_events ADD COLUMN currency TEXT;
ALTER TABLE llm_usage_events ADD COLUMN pricing_version TEXT;
ALTER TABLE llm_usage_events ADD COLUMN api_endpoint TEXT;
