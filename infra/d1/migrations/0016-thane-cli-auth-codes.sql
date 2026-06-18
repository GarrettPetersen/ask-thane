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
