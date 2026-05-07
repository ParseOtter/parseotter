import {
  expireTaskIfPastBoundary,
  findTaskSnapshotById,
  rowToTaskSnapshot,
  type TaskRow,
  updateTaskSnapshotConditionally,
} from './task-record'
import { mapInternalStatusToVisibleStatus, type TaskSnapshot } from './task-status'

export type DispatchOutboxResult = {
  snapshot: TaskSnapshot | null
}

export type MarkDispatchPendingResult = DispatchOutboxResult & {
  created: boolean
}

export type ClaimDispatchPendingResult = DispatchOutboxResult & {
  claimed: boolean
}

function normalizeListLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return 100
  }

  return Math.min(limit, 500)
}

function createDispatchIdempotencyKey(taskId: string, attempt: number): string {
  return `${taskId}:dispatch:${attempt}`
}

function createPendingSnapshot(snapshot: TaskSnapshot, now: Date): TaskSnapshot {
  const dispatchAttempt = Math.max(snapshot.attempt, snapshot.dispatchAttempt) + 1
  const nowIso = now.toISOString()

  return {
    ...snapshot,
    status: 'dispatch_pending',
    visibleStatus: mapInternalStatusToVisibleStatus('dispatch_pending'),
    version: snapshot.version + 1,
    attempt: dispatchAttempt,
    updatedAt: nowIso,
    dispatchStatus: 'pending',
    dispatchAttempt,
    dispatchIdempotencyKey: createDispatchIdempotencyKey(snapshot.taskId, dispatchAttempt),
    dispatchStartedAt: null,
    dispatchCompletedAt: null,
  }
}

function createClaimedSnapshot(snapshot: TaskSnapshot, now: Date): TaskSnapshot {
  const nowIso = now.toISOString()

  return {
    ...snapshot,
    status: 'dispatching',
    visibleStatus: mapInternalStatusToVisibleStatus('dispatching'),
    version: snapshot.version + 1,
    updatedAt: nowIso,
    dispatchStatus: 'dispatching',
    dispatchStartedAt: nowIso,
  }
}

function canCreateDispatchPending(snapshot: TaskSnapshot): boolean {
  return snapshot.status === 'upload_completed' && snapshot.dispatchStatus === null
}

function isPendingDispatch(snapshot: TaskSnapshot): boolean {
  return snapshot.status === 'dispatch_pending' && snapshot.dispatchStatus === 'pending'
}

function isClaimedDispatch(snapshot: TaskSnapshot): boolean {
  return snapshot.status === 'dispatching' && snapshot.dispatchStatus === 'dispatching'
}

async function readAccessibleSnapshot(db: D1Database, taskId: string, now: Date): Promise<TaskSnapshot | null> {
  const snapshot = await findTaskSnapshotById(db, taskId)

  if (!snapshot) {
    return null
  }

  return expireTaskIfPastBoundary(db, snapshot, now)
}

export async function markTaskDispatchPending(
  db: D1Database,
  taskId: string,
  now = new Date()
): Promise<MarkDispatchPendingResult> {
  const snapshot = await readAccessibleSnapshot(db, taskId, now)

  if (!snapshot || snapshot.status === 'expired') {
    return { created: false, snapshot }
  }

  if (isPendingDispatch(snapshot) || isClaimedDispatch(snapshot)) {
    return { created: false, snapshot }
  }

  if (!canCreateDispatchPending(snapshot)) {
    return { created: false, snapshot }
  }

  const pendingSnapshot = createPendingSnapshot(snapshot, now)
  const updated = await updateTaskSnapshotConditionally(db, pendingSnapshot, snapshot.version)

  if (!updated) {
    return {
      created: false,
      snapshot: await findTaskSnapshotById(db, taskId),
    }
  }

  return {
    created: true,
    snapshot: pendingSnapshot,
  }
}

export async function claimDispatchPendingTask(
  db: D1Database,
  taskId: string,
  now = new Date()
): Promise<ClaimDispatchPendingResult> {
  const snapshot = await readAccessibleSnapshot(db, taskId, now)

  if (!snapshot || snapshot.status === 'expired') {
    return { claimed: false, snapshot }
  }

  if (isClaimedDispatch(snapshot)) {
    return { claimed: false, snapshot }
  }

  if (!isPendingDispatch(snapshot)) {
    return { claimed: false, snapshot }
  }

  const claimedSnapshot = createClaimedSnapshot(snapshot, now)
  const updated = await updateTaskSnapshotConditionally(db, claimedSnapshot, snapshot.version)

  if (!updated) {
    return {
      claimed: false,
      snapshot: await findTaskSnapshotById(db, taskId),
    }
  }

  return {
    claimed: true,
    snapshot: claimedSnapshot,
  }
}

export async function listDispatchPendingSnapshots(
  db: D1Database,
  now = new Date(),
  limit = 100
): Promise<TaskSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT * FROM parseotter_tasks
      WHERE status = ? AND dispatch_status = ? AND expires_at > ?
      ORDER BY updated_at ASC
      LIMIT ?`
    )
    .bind('dispatch_pending', 'pending', now.toISOString(), normalizeListLimit(limit))
    .all<TaskRow>()

  return result.results.map(rowToTaskSnapshot)
}
