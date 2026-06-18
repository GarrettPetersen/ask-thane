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
