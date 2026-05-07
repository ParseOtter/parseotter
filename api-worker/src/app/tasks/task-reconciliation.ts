import { readProcessingTimeoutSeconds } from '../runtime-config'
import { createOutputObjectKey } from './modal-dispatch'
import {
  getAccessibleTaskSnapshot,
  persistProcessingTimeoutFailure,
  persistRecoveredTaskSuccess,
  rowToTaskSnapshot,
  type TaskRow,
} from './task-record'
import type { TaskSnapshot } from './task-status'

const RECONCILABLE_STATUSES = new Set<TaskSnapshot['status']>(['dispatching', 'processing'])

function isReconciliationCandidate(snapshot: TaskSnapshot): boolean {
  return RECONCILABLE_STATUSES.has(snapshot.status) && snapshot.lastCallbackIdempotencyKey === null
}

function hasProcessingTimedOut(snapshot: TaskSnapshot, now: Date, timeoutSeconds: number): boolean {
  if (!snapshot.dispatchStartedAt) {
    return false
  }

  const dispatchStartedAt = Date.parse(snapshot.dispatchStartedAt)
  if (!Number.isFinite(dispatchStartedAt)) {
    return false
  }

  return now.getTime() - dispatchStartedAt >= timeoutSeconds * 1000
}

function normalizeSweepLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return 100
  }

  return Math.min(limit, 500)
}

async function listReconciliationCandidates(db: D1Database, now: Date, limit: number): Promise<TaskSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT * FROM parseotter_tasks
      WHERE status IN (?, ?) AND last_callback_idempotency_key IS NULL AND expires_at > ?
      ORDER BY updated_at ASC
      LIMIT ?`
    )
    .bind('dispatching', 'processing', now.toISOString(), normalizeSweepLimit(limit))
    .all<TaskRow>()

  return result.results.map(rowToTaskSnapshot)
}

export async function reconcileLoadedTaskSnapshot(input: {
  db: D1Database
  bucket: R2Bucket
  env?: Partial<CloudflareBindings>
  snapshot: TaskSnapshot
  now?: Date
}): Promise<TaskSnapshot> {
  const now = input.now ?? new Date()
  const snapshot = input.snapshot

  if (!isReconciliationCandidate(snapshot)) {
    return snapshot
  }

  const outputObjectKey = createOutputObjectKey(snapshot.taskId)
  const outputObject = await input.bucket.head(outputObjectKey)
  if (outputObject) {
    return (
      (await persistRecoveredTaskSuccess(input.db, {
        taskId: snapshot.taskId,
        outputObjectKey,
        outputContentType: outputObject.httpMetadata?.contentType ?? 'application/zip',
        outputSizeBytes: outputObject.size,
        now,
      })) ?? snapshot
    )
  }

  if (!hasProcessingTimedOut(snapshot, now, readProcessingTimeoutSeconds(input.env))) {
    return snapshot
  }

  return (
    (await persistProcessingTimeoutFailure(input.db, {
      taskId: snapshot.taskId,
      now,
    })) ?? snapshot
  )
}

export async function reconcileTaskSnapshot(input: {
  db: D1Database
  bucket: R2Bucket
  env?: Partial<CloudflareBindings>
  taskId: string
  now?: Date
}): Promise<TaskSnapshot> {
  const now = input.now ?? new Date()
  const snapshot = await getAccessibleTaskSnapshot(input.db, input.taskId, now)

  return reconcileLoadedTaskSnapshot({
    db: input.db,
    bucket: input.bucket,
    env: input.env,
    snapshot,
    now,
  })
}

export async function reconcileStuckTasks(input: {
  db: D1Database
  bucket: R2Bucket
  env?: Partial<CloudflareBindings>
  now?: Date
  limit?: number
}): Promise<{
  scanned: number
  recoveredSucceeded: number
  markedFailed: number
  failures: number
}> {
  const now = input.now ?? new Date()
  const candidates = await listReconciliationCandidates(input.db, now, input.limit ?? 100)
  let recoveredSucceeded = 0
  let markedFailed = 0
  let failures = 0

  for (const snapshot of candidates) {
    try {
      const reconciled = await reconcileLoadedTaskSnapshot({
        db: input.db,
        bucket: input.bucket,
        env: input.env,
        snapshot,
        now,
      })

      if (snapshot.status !== 'succeeded' && reconciled.status === 'succeeded') {
        recoveredSucceeded += 1
      }

      if (snapshot.status !== 'failed' && reconciled.errorCode === 'PROCESSING_TIMEOUT') {
        markedFailed += 1
      }
    } catch {
      failures += 1
    }
  }

  return {
    scanned: candidates.length,
    recoveredSucceeded,
    markedFailed,
    failures,
  }
}
