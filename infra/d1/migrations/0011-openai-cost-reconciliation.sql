PRAGMA foreign_keys = ON;

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
