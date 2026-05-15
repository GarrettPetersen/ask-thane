PRAGMA foreign_keys = ON;

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
