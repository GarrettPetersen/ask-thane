CREATE TABLE IF NOT EXISTS person_notification_preferences (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  preferred_ping_location TEXT NOT NULL CHECK(preferred_ping_location IN ('origin', 'thane_cli', 'slack', 'both')),
  updated_by_platform TEXT,
  updated_by_external_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  UNIQUE(organization_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_person_notification_preferences_org_person
  ON person_notification_preferences(organization_id, person_id);
