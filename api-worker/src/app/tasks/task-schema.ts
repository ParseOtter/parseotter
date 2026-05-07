export const TASKS_TABLE_NAME = 'parseotter_tasks'

export const TASKS_SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS parseotter_tasks (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, visible_status TEXT NOT NULL, version INTEGER NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, expired_at TEXT, error_code TEXT, error_message TEXT, file_name TEXT NOT NULL, file_type TEXT NOT NULL, file_size_bytes INTEGER NOT NULL, upload_id TEXT, upload_status TEXT, input_object_key TEXT, input_size_bytes INTEGER, input_etag TEXT, input_content_type TEXT, input_part_count INTEGER, input_checksum_sha256 TEXT, output_object_key TEXT, output_content_type TEXT, output_size_bytes INTEGER, dispatch_status TEXT, dispatch_attempt INTEGER NOT NULL DEFAULT 0, dispatch_idempotency_key TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT, last_callback_idempotency_key TEXT, client_hash TEXT, client_user_agent TEXT, client_ip_hash TEXT, ga_client_id TEXT);',
  'CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_expires_at ON parseotter_tasks (expires_at);',
  'CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_status_expires_at ON parseotter_tasks (status, expires_at);',
  'CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_client_hash_created_at ON parseotter_tasks (client_hash, created_at);',
  'CREATE INDEX IF NOT EXISTS idx_parseotter_tasks_client_hash_status_expires_at ON parseotter_tasks (client_hash, status, expires_at);',
] as const

export const TASKS_SCHEMA_SQL = TASKS_SCHEMA_STATEMENTS.join('\n\n')
