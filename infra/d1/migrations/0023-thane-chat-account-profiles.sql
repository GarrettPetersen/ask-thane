CREATE TABLE IF NOT EXISTS thane_cli_account_profiles (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
