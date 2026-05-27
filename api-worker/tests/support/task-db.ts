import { TASKS_SCHEMA_STATEMENTS } from '../../src/app/tasks/task-schema'
import { ABUSE_SCHEMA_STATEMENTS } from '../../src/app/abuse/abuse-schema'

type GlobImportMeta = ImportMeta & {
  glob: <T>(pattern: string, options: { query: string; import: string; eager: true }) => Record<string, T>
}

const TASK_MIGRATION_SQL_BY_PATH = (import.meta as GlobImportMeta).glob<string>('../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function readMigrationStatements(migrationSql: string): string[] {
  return migrationSql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0)
}

export async function resetTaskDatabase(db: D1Database): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS parseotter_abuse_events;')
  await db.exec('DROP TABLE IF EXISTS parseotter_client_action_events;')
  await db.exec('DROP TABLE IF EXISTS parseotter_global_usage_daily;')
  await db.exec('DROP TABLE IF EXISTS parseotter_client_usage_daily;')
  await db.exec('DROP TABLE IF EXISTS parseotter_tasks;')
  await db.exec('DROP TABLE IF EXISTS parseotter_api_keys;')
  for (const statement of TASKS_SCHEMA_STATEMENTS) {
    await db.exec(statement)
  }
  for (const statement of ABUSE_SCHEMA_STATEMENTS) {
    await db.exec(statement)
  }
  await db.exec('CREATE TABLE IF NOT EXISTS parseotter_api_keys (key_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, owner_label TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), last_used_at TEXT, revoked_at TEXT);')
  await db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON parseotter_api_keys(key_hash);')
}

export async function resetTaskDatabaseFromMigrations(db: D1Database): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS parseotter_abuse_events;')
  await db.exec('DROP TABLE IF EXISTS parseotter_client_action_events;')
  await db.exec('DROP TABLE IF EXISTS parseotter_global_usage_daily;')
  await db.exec('DROP TABLE IF EXISTS parseotter_client_usage_daily;')
  await db.exec('DROP TABLE IF EXISTS parseotter_tasks;')

  const migrations = Object.entries(TASK_MIGRATION_SQL_BY_PATH).sort(([leftPath], [rightPath]) =>
    leftPath.localeCompare(rightPath)
  )

  if (migrations.length === 0) {
    throw new Error('No ParseOtter migrations found for task database tests')
  }

  for (const [, migrationSql] of migrations) {
    for (const statement of readMigrationStatements(migrationSql)) {
      await db.exec(statement)
    }
  }
}
