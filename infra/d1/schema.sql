PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  billing_email TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_external_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_type TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  display_name TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(provider, external_account_type, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_org_external_accounts_org
  ON organization_external_accounts(organization_id, provider);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_workspace_id TEXT NOT NULL,
  name TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(platform, external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(organization_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspace_id, platform, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_users_org_workspace ON users(organization_id, workspace_id);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_org_role ON memberships(organization_id, role);

CREATE TABLE IF NOT EXISTS conversation_sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_conversation_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  visibility_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(organization_id, provider, provider_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_sources_org_workspace
  ON conversation_sources(organization_id, workspace_id);

CREATE TABLE IF NOT EXISTS conversation_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  version TEXT,
  synced_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(conversation_source_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_memberships_org_user_active
  ON conversation_memberships(organization_id, user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_conversation_memberships_conversation_active
  ON conversation_memberships(conversation_source_id, is_active);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  primary_conversation_source_id TEXT,
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
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (primary_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_org_status ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee_status ON tasks(organization_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_source_message ON tasks(organization_id, source_message_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_primary_conversation ON tasks(organization_id, primary_conversation_source_id);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_source_id TEXT,
  event_type TEXT NOT NULL,
  actor_platform TEXT,
  actor_id TEXT,
  actor_name TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_org_task_created ON task_events(organization_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_org_conversation ON task_events(organization_id, conversation_source_id);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_task_event_id TEXT,
  recipient_platform TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  delivery_channel_id TEXT,
  sent_at TEXT NOT NULL,
  response_message_id TEXT,
  response_state TEXT,
  metadata_json TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_task_event_id) REFERENCES task_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_org_sent ON reminders(organization_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_reminders_org_source_task_event ON reminders(organization_id, source_task_event_id);

CREATE TABLE IF NOT EXISTS resource_acl (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  conversation_source_id TEXT,
  acl_mode TEXT NOT NULL CHECK(acl_mode IN ('inherit', 'intersection', 'restricted')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE CASCADE,
  UNIQUE(organization_id, resource_type, resource_id, conversation_source_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_acl_org_resource
  ON resource_acl(organization_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_acl_org_conversation
  ON resource_acl(organization_id, conversation_source_id);

CREATE TABLE IF NOT EXISTS ingest_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_message_id TEXT,
  conversation_source_id TEXT,
  event_type TEXT,
  event_subtype TEXT,
  channel_id TEXT,
  actor_external_user_id TEXT,
  event_ts TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL,
  UNIQUE(organization_id, provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_ingest_events_org_provider_message
  ON ingest_events(organization_id, provider, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_ingest_events_org_conversation
  ON ingest_events(organization_id, conversation_source_id);
CREATE INDEX IF NOT EXISTS idx_ingest_events_org_event_type_received
  ON ingest_events(organization_id, provider, event_type, received_at DESC);

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT,
  user_id TEXT,
  provider TEXT NOT NULL,
  external_workspace_id TEXT,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, provider, external_user_id, external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_org_user ON external_identities(organization_id, user_id);

CREATE TABLE IF NOT EXISTS slack_workspace_installs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_workspace_id TEXT NOT NULL,
  team_name TEXT,
  bot_token TEXT NOT NULL,
  bot_user_id TEXT,
  bot_scope TEXT,
  token_type TEXT,
  installed_by_external_user_id TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspace_id),
  UNIQUE(external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_workspace_installs_org_workspace
  ON slack_workspace_installs(organization_id, workspace_id);

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  company TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'landing_page',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_signups_status_created
  ON waitlist_signups(status, created_at);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  canonical_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_people_org ON people(organization_id);

CREATE TABLE IF NOT EXISTS identity_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_workspace_id TEXT,
  external_user_id TEXT NOT NULL,
  user_id TEXT,
  email TEXT,
  display_name TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, provider, external_user_id, external_workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_org_person
  ON identity_accounts(organization_id, person_id);

CREATE TABLE IF NOT EXISTS agent_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('organization', 'workspace', 'conversation', 'person', 'user', 'task')),
  scope_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('private', 'organization', 'conversation_acl')),
  content TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('agent', 'system', 'user')),
  author_id TEXT,
  source_conversation_source_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_notes_scope
  ON agent_notes(organization_id, scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_actions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('create', 'mark_done', 'mark_cancelled', 'mark_blocked', 'reopen', 'merge_into', 'edit')),
  actor_platform TEXT,
  actor_id TEXT,
  actor_name TEXT,
  source_conversation_source_id TEXT,
  payload_json TEXT,
  resulted_status TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_actions_org_task_created
  ON task_actions(organization_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS permission_waivers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  granter_user_id TEXT,
  requested_scope_type TEXT NOT NULL CHECK(requested_scope_type IN ('organization', 'workspace', 'conversation', 'person', 'user', 'task')),
  requested_scope_id TEXT NOT NULL,
  request_reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'granted', 'denied', 'revoked', 'expired')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT,
  metadata_json TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granter_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_permission_waivers_org_resource
  ON permission_waivers(organization_id, resource_type, resource_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS workspace_poll_cursors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  cursor_key TEXT NOT NULL,
  last_cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(organization_id, workspace_id, provider, cursor_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_poll_cursors_org_workspace
  ON workspace_poll_cursors(organization_id, workspace_id, provider);

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
  prompt_cost_usd REAL,
  completion_cost_usd REAL,
  total_cost_usd REAL,
  currency TEXT,
  pricing_version TEXT,
  api_endpoint TEXT,
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

CREATE TABLE IF NOT EXISTS openai_cost_reconciliation_daily (
  id TEXT PRIMARY KEY,
  usage_date TEXT NOT NULL UNIQUE,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL NOT NULL DEFAULT 0,
  variance_cost_usd REAL NOT NULL DEFAULT 0,
  variance_ratio REAL,
  alert_threshold_ratio REAL NOT NULL DEFAULT 0.10,
  alert_triggered INTEGER NOT NULL DEFAULT 0,
  alerted_at TEXT,
  currency TEXT NOT NULL DEFAULT 'usd',
  openai_request_id TEXT,
  source_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_cost_reconciliation_daily_date
  ON openai_cost_reconciliation_daily(usage_date DESC);

CREATE TABLE IF NOT EXISTS thane_cli_auth_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  code_hash TEXT NOT NULL,
  delivery_channel TEXT NOT NULL DEFAULT 'email',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_auth_codes_email_created
  ON thane_cli_auth_codes(email, created_at);

CREATE INDEX IF NOT EXISTS idx_thane_cli_auth_codes_expires
  ON thane_cli_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS thane_cli_mfa_factors (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  factor_type TEXT NOT NULL DEFAULT 'totp',
  secret_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  enabled_at TEXT,
  disabled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_mfa_factors_email
  ON thane_cli_mfa_factors(email, factor_type, enabled_at, disabled_at);

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

CREATE TABLE IF NOT EXISTS thane_cli_rate_limits (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_hint TEXT,
  window_started_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(purpose, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_rate_limits_purpose_updated
  ON thane_cli_rate_limits(purpose, updated_at);

CREATE TABLE IF NOT EXISTS thane_cli_workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  workspace_slug TEXT NOT NULL,
  workspace_name TEXT,
  ascii_art TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK(plan_tier IN ('free', 'cli_team')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thane_cli_workspaces_slug
  ON thane_cli_workspaces(workspace_slug);

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

CREATE TABLE IF NOT EXISTS thane_cli_account_profiles (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS thane_cli_workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  handle TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  UNIQUE(workspace_id, email)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_members_email
  ON thane_cli_workspace_members(email, workspace_id);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_members_active
  ON thane_cli_workspace_members(workspace_id, left_at);

CREATE TABLE IF NOT EXISTS thane_cli_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel' CHECK(kind IN ('channel', 'dm')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),
  topic TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_channels_workspace
  ON thane_cli_channels(workspace_id, name);

CREATE TABLE IF NOT EXISTS thane_cli_channel_members (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  FOREIGN KEY(channel_id) REFERENCES thane_cli_channels(id),
  FOREIGN KEY(member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(channel_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_channel_members_member
  ON thane_cli_channel_members(member_id, channel_id);

CREATE TABLE IF NOT EXISTS thane_cli_chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_member_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat', 'terminal')),
  origin TEXT CHECK(origin IN ('chat', 'terminal', 'webhook')),
  thread_root_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(channel_id) REFERENCES thane_cli_channels(id),
  FOREIGN KEY(author_member_id) REFERENCES thane_cli_workspace_members(id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_chat_messages_channel_created
  ON thane_cli_chat_messages(channel_id, created_at);

CREATE INDEX IF NOT EXISTS idx_thane_cli_chat_messages_workspace_created
  ON thane_cli_chat_messages(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS thane_cli_message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES thane_cli_chat_messages(id),
  FOREIGN KEY(member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(message_id, member_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_message_reactions_message
  ON thane_cli_message_reactions(message_id);

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
