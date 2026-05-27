CREATE TABLE IF NOT EXISTS parseotter_api_keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  owner_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON parseotter_api_keys(key_hash);
