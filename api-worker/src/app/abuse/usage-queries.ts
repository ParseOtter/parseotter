export type AbuseRoute =
  | 'create_task'
  | 'upload_session'
  | 'sign_parts'
  | 'complete_upload'
  | 'status_poll'
  | 'download'
  | 'feedback'

export type AbuseEventType = 'rate_limited' | 'turnstile_failed' | 'quota_rejected' | 'disabled'

export type DailyUsage = {
  createdCount: number
  uploadCompletedCount: number
  dispatchCount: number
  uploadCompletedBytes: number
  rateLimitedCount: number
  turnstileFailedCount: number
}

const ACTIVE_TASK_STATUSES = [
  'created',
  'upload_pending',
  'uploading',
  'upload_completed',
  'dispatch_pending',
  'dispatching',
  'processing',
] as const

export function getUsageDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function oneHourBefore(now: Date): Date {
  return new Date(now.getTime() - 60 * 60 * 1000)
}

function rowToDailyUsage(row?: Partial<Record<string, number>> | null): DailyUsage {
  return {
    createdCount: row?.created_count ?? 0,
    uploadCompletedCount: row?.upload_completed_count ?? 0,
    dispatchCount: row?.dispatch_count ?? 0,
    uploadCompletedBytes: row?.upload_completed_bytes ?? 0,
    rateLimitedCount: row?.rate_limited_count ?? 0,
    turnstileFailedCount: row?.turnstile_failed_count ?? 0,
  }
}

export async function readClientDailyUsage(
  db: D1Database,
  input: {
    clientHash: string
    now?: Date
  }
): Promise<DailyUsage> {
  const now = input.now ?? new Date()
  const row = await db
    .prepare(
      `SELECT created_count, upload_completed_count, dispatch_count, upload_completed_bytes,
              rate_limited_count, turnstile_failed_count
       FROM parseotter_client_usage_daily
       WHERE usage_date = ? AND client_hash = ?`
    )
    .bind(getUsageDate(now), input.clientHash)
    .first<Record<string, number>>()

  return rowToDailyUsage(row)
}

export async function readGlobalDailyUsage(db: D1Database, now = new Date()): Promise<DailyUsage> {
  const row = await db
    .prepare(
      `SELECT created_count, upload_completed_count, dispatch_count, upload_completed_bytes,
              rate_limited_count, turnstile_failed_count
       FROM parseotter_global_usage_daily
       WHERE usage_date = ?`
    )
    .bind(getUsageDate(now))
    .first<Record<string, number>>()

  return rowToDailyUsage(row)
}

export async function countClientActionEventsSince(
  db: D1Database,
  input: {
    clientHash: string
    route: AbuseRoute
    since: Date
  }
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM parseotter_client_action_events
       WHERE client_hash = ? AND route = ? AND created_at >= ?`
    )
    .bind(input.clientHash, input.route, input.since.toISOString())
    .first<{ count: number }>()

  return row?.count ?? 0
}

export async function countClientCreatedTasksSince(
  db: D1Database,
  input: {
    clientHash: string
    since: Date
  }
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM parseotter_tasks
       WHERE client_hash = ? AND created_at >= ?`
    )
    .bind(input.clientHash, input.since.toISOString())
    .first<{ count: number }>()

  return row?.count ?? 0
}

export async function countClientActiveTasks(
  db: D1Database,
  input: {
    clientHash: string
    now?: Date
    excludingTaskId?: string
  }
): Promise<number> {
  const now = input.now ?? new Date()
  const statusPlaceholders = ACTIVE_TASK_STATUSES.map(() => '?').join(', ')
  const excludingClause = input.excludingTaskId ? ' AND task_id != ?' : ''
  const statement = db.prepare(
    `SELECT COUNT(*) AS count
     FROM parseotter_tasks
     WHERE client_hash = ?
       AND status IN (${statusPlaceholders})
       AND expires_at > ?
       ${excludingClause}`
  )
  const bindings = [
    input.clientHash,
    ...ACTIVE_TASK_STATUSES,
    now.toISOString(),
    ...(input.excludingTaskId ? [input.excludingTaskId] : []),
  ]
  const row = await statement.bind(...bindings).first<{ count: number }>()

  return row?.count ?? 0
}

export async function countGlobalActiveDispatches(db: D1Database, now = new Date()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM parseotter_tasks
       WHERE status IN (?, ?)
         AND expires_at > ?`
    )
    .bind('dispatching', 'processing', now.toISOString())
    .first<{ count: number }>()

  return row?.count ?? 0
}

export async function countGlobalPendingDispatches(db: D1Database, now = new Date()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM parseotter_tasks
       WHERE status = ? AND dispatch_status = ? AND expires_at > ?`
    )
    .bind('dispatch_pending', 'pending', now.toISOString())
    .first<{ count: number }>()

  return row?.count ?? 0
}
