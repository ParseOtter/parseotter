CREATE TABLE IF NOT EXISTS parseotter_tasks (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  visible_status TEXT NOT NULL,
  version INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expired_at TEXT,
  error_code TEXT,
  error_message TEXT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  upload_id TEXT,
  upload_status TEXT,
  input_object_key TEXT,
  input_size_bytes INTEGER,
  input_etag TEXT,
  input_content_type TEXT,
  input_part_count INTEGER,
  input_checksum_sha256 TEXT,
  output_object_key TEXT,
  output_content_type TEXT,
  output_size_bytes INTEGER,
  dispatch_status TEXT,
  dispatch_attempt INTEGER NOT NULL DEFAULT 0,
  dispatch_idempotency_key TEXT,
  dispatch_started_at TEXT,
  dispatch_completed_at TEXT,
  last_callback_idempotency_key TEXT,
  client_hash TEXT,
  client_user_agent TEXT,
  client_ip_hash TEXT,
  ga_client_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_expires_at
  ON parseotter_tasks (expires_at);

CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_status_expires_at
  ON parseotter_tasks (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_client_hash_created_at
  ON parseotter_tasks (client_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_client_hash_status_expires_at
  ON parseotter_tasks (client_hash, status, expires_at);

CREATE TABLE IF NOT EXISTS parseotter_feedback (
  feedback_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  rating INTEGER,
  message TEXT NOT NULL,
  contact TEXT,
  page_url TEXT,
  user_agent TEXT,
  client_hash TEXT NOT NULL,
  request_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parseotter_feedback_created_at
  ON parseotter_feedback (created_at);

CREATE INDEX IF NOT EXISTS idx_parseotter_feedback_client_hash_created_at
  ON parseotter_feedback (client_hash, created_at);

CREATE TABLE IF NOT EXISTS parseotter_client_usage_daily (
  usage_date TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  upload_completed_count INTEGER NOT NULL DEFAULT 0,
  dispatch_count INTEGER NOT NULL DEFAULT 0,
  upload_completed_bytes INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  turnstile_failed_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, client_hash)
);

CREATE TABLE IF NOT EXISTS parseotter_global_usage_daily (
  usage_date TEXT PRIMARY KEY,
  created_count INTEGER NOT NULL DEFAULT 0,
  upload_completed_count INTEGER NOT NULL DEFAULT 0,
  dispatch_count INTEGER NOT NULL DEFAULT 0,
  upload_completed_bytes INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  turnstile_failed_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parseotter_client_action_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  route TEXT NOT NULL,
  task_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_parseotter_client_action_events_client_route_created_at
  ON parseotter_client_action_events (client_hash, route, created_at);

CREATE TABLE IF NOT EXISTS parseotter_abuse_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  client_hash TEXT,
  task_id TEXT,
  route TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  status INTEGER NOT NULL,
  request_id TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_parseotter_abuse_events_created_at
  ON parseotter_abuse_events (created_at);

CREATE INDEX IF NOT EXISTS idx_parseotter_abuse_events_client_created_at
  ON parseotter_abuse_events (client_hash, created_at);
