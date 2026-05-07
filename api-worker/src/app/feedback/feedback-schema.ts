export const FEEDBACK_TABLE_NAME = 'parseotter_feedback'

export const FEEDBACK_SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS parseotter_feedback (feedback_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, category TEXT NOT NULL, rating INTEGER, message TEXT NOT NULL, contact TEXT, page_url TEXT, user_agent TEXT, client_hash TEXT NOT NULL, request_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL);',
  'CREATE INDEX IF NOT EXISTS idx_parseotter_feedback_created_at ON parseotter_feedback (created_at);',
  'CREATE INDEX IF NOT EXISTS idx_parseotter_feedback_client_hash_created_at ON parseotter_feedback (client_hash, created_at);',
] as const

export const FEEDBACK_SCHEMA_SQL = FEEDBACK_SCHEMA_STATEMENTS.join('\n\n')
