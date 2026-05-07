import { getUsageDate, type AbuseEventType, type AbuseRoute } from './usage-queries'

function createEventId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

async function incrementClientDailyUsage(
  db: D1Database,
  input: {
    clientHash: string
    now: Date
    createdCount?: number
    uploadCompletedCount?: number
    dispatchCount?: number
    uploadCompletedBytes?: number
    rateLimitedCount?: number
    turnstileFailedCount?: number
  }
): Promise<void> {
  const usageDate = getUsageDate(input.now)
  const nowIso = input.now.toISOString()

  await db
    .prepare(
      `INSERT INTO parseotter_client_usage_daily (
        usage_date, client_hash, created_count, upload_completed_count, dispatch_count,
        upload_completed_bytes, rate_limited_count, turnstile_failed_count, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(usage_date, client_hash) DO UPDATE SET
        created_count = created_count + excluded.created_count,
        upload_completed_count = upload_completed_count + excluded.upload_completed_count,
        dispatch_count = dispatch_count + excluded.dispatch_count,
        upload_completed_bytes = upload_completed_bytes + excluded.upload_completed_bytes,
        rate_limited_count = rate_limited_count + excluded.rate_limited_count,
        turnstile_failed_count = turnstile_failed_count + excluded.turnstile_failed_count,
        last_seen_at = excluded.last_seen_at`
    )
    .bind(
      usageDate,
      input.clientHash,
      input.createdCount ?? 0,
      input.uploadCompletedCount ?? 0,
      input.dispatchCount ?? 0,
      input.uploadCompletedBytes ?? 0,
      input.rateLimitedCount ?? 0,
      input.turnstileFailedCount ?? 0,
      nowIso
    )
    .run()
}

async function incrementGlobalDailyUsage(
  db: D1Database,
  input: {
    now: Date
    createdCount?: number
    uploadCompletedCount?: number
    dispatchCount?: number
    uploadCompletedBytes?: number
    rateLimitedCount?: number
    turnstileFailedCount?: number
  }
): Promise<void> {
  const usageDate = getUsageDate(input.now)
  const nowIso = input.now.toISOString()

  await db
    .prepare(
      `INSERT INTO parseotter_global_usage_daily (
        usage_date, created_count, upload_completed_count, dispatch_count,
        upload_completed_bytes, rate_limited_count, turnstile_failed_count, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(usage_date) DO UPDATE SET
        created_count = created_count + excluded.created_count,
        upload_completed_count = upload_completed_count + excluded.upload_completed_count,
        dispatch_count = dispatch_count + excluded.dispatch_count,
        upload_completed_bytes = upload_completed_bytes + excluded.upload_completed_bytes,
        rate_limited_count = rate_limited_count + excluded.rate_limited_count,
        turnstile_failed_count = turnstile_failed_count + excluded.turnstile_failed_count,
        last_seen_at = excluded.last_seen_at`
    )
    .bind(
      usageDate,
      input.createdCount ?? 0,
      input.uploadCompletedCount ?? 0,
      input.dispatchCount ?? 0,
      input.uploadCompletedBytes ?? 0,
      input.rateLimitedCount ?? 0,
      input.turnstileFailedCount ?? 0,
      nowIso
    )
    .run()
}

export async function incrementTaskCreatedUsage(
  db: D1Database,
  input: {
    clientHash: string
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()
  await incrementClientDailyUsage(db, { clientHash: input.clientHash, now, createdCount: 1 })
  await incrementGlobalDailyUsage(db, { now, createdCount: 1 })
  await insertClientActionEvent(db, {
    clientHash: input.clientHash,
    route: 'create_task',
    now,
  })
}

export async function incrementUploadCompletedUsage(
  db: D1Database,
  input: {
    clientHash: string
    bytes: number
    taskId: string
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()
  await incrementClientDailyUsage(db, {
    clientHash: input.clientHash,
    now,
    uploadCompletedCount: 1,
    uploadCompletedBytes: input.bytes,
  })
  await incrementGlobalDailyUsage(db, {
    now,
    uploadCompletedCount: 1,
    uploadCompletedBytes: input.bytes,
  })
  await insertClientActionEvent(db, {
    clientHash: input.clientHash,
    route: 'complete_upload',
    taskId: input.taskId,
    now,
  })
}

export async function incrementDispatchUsage(
  db: D1Database,
  input: {
    clientHash: string | null
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()
  if (input.clientHash) {
    await incrementClientDailyUsage(db, { clientHash: input.clientHash, now, dispatchCount: 1 })
  }
  await incrementGlobalDailyUsage(db, { now, dispatchCount: 1 })
}

export async function recordRateLimitedUsage(
  db: D1Database,
  input: {
    clientHash: string
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()
  await incrementClientDailyUsage(db, { clientHash: input.clientHash, now, rateLimitedCount: 1 })
  await incrementGlobalDailyUsage(db, { now, rateLimitedCount: 1 })
}

export async function recordTurnstileFailedUsage(
  db: D1Database,
  input: {
    clientHash: string
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()
  await incrementClientDailyUsage(db, { clientHash: input.clientHash, now, turnstileFailedCount: 1 })
  await incrementGlobalDailyUsage(db, { now, turnstileFailedCount: 1 })
}

export async function recordAbuseEvent(
  db: D1Database,
  input: {
    route: AbuseRoute
    eventType: AbuseEventType
    reasonCode: string
    status: number
    clientHash?: string | null
    taskId?: string | null
    requestId?: string | null
    metadata?: Record<string, unknown>
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()

  await db
    .prepare(
      `INSERT INTO parseotter_abuse_events (
        event_id, created_at, usage_date, client_hash, task_id, route, event_type,
        reason_code, status, request_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      createEventId('abuse'),
      now.toISOString(),
      getUsageDate(now),
      input.clientHash ?? null,
      input.taskId ?? null,
      input.route,
      input.eventType,
      input.reasonCode,
      input.status,
      input.requestId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    )
    .run()
}

export async function insertClientActionEvent(
  db: D1Database,
  input: {
    clientHash: string
    route: AbuseRoute
    taskId?: string | null
    now?: Date
  }
): Promise<void> {
  const now = input.now ?? new Date()

  await db
    .prepare(
      `INSERT INTO parseotter_client_action_events (
        event_id, created_at, usage_date, client_hash, route, task_id
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      createEventId('action'),
      now.toISOString(),
      getUsageDate(now),
      input.clientHash,
      input.route,
      input.taskId ?? null
    )
    .run()
}
