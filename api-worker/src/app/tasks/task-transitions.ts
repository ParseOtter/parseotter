import { AppHttpError } from '../http/errors'
import { findTaskSnapshotById, updateTaskSnapshotConditionally } from './task-queries'
import {
  applyTaskTransition,
  createExpiredTransition,
  type TaskSnapshot,
  type TaskTransition,
} from './task-status'

export async function transitionTaskSnapshot(
  db: D1Database,
  taskId: string,
  transition: TaskTransition
): Promise<TaskSnapshot | null> {
  const current = await findTaskSnapshotById(db, taskId)

  if (!current) {
    return null
  }

  const result = applyTaskTransition(current, transition)

  if (!result.applied) {
    return current
  }

  const updated = await updateTaskSnapshotConditionally(db, result.snapshot, current.version)

  if (!updated) {
    return findTaskSnapshotById(db, taskId)
  }

  return result.snapshot
}

async function markAlreadyExpiredSnapshot(db: D1Database, snapshot: TaskSnapshot, now: Date): Promise<TaskSnapshot> {
  if (snapshot.expiredAt) {
    return snapshot
  }

  const nowIso = now.toISOString()
  await db
    .prepare(
      `UPDATE parseotter_tasks SET
        updated_at = ?,
        expired_at = ?,
        error_code = COALESCE(error_code, ?),
        error_message = COALESCE(error_message, ?)
      WHERE task_id = ? AND expired_at IS NULL`
    )
    .bind(nowIso, nowIso, 'TASK_EXPIRED', 'Task has expired', snapshot.taskId)
    .run()

  return {
    ...snapshot,
    updatedAt: nowIso,
    expiredAt: nowIso,
    errorCode: snapshot.errorCode ?? 'TASK_EXPIRED',
    errorMessage: snapshot.errorMessage ?? 'Task has expired',
  }
}

export async function markTaskExpiredForCleanup(
  db: D1Database,
  snapshot: TaskSnapshot,
  now: Date
): Promise<{ marked: boolean; snapshot: TaskSnapshot }> {
  if (snapshot.status === 'expired') {
    const updatedSnapshot = await markAlreadyExpiredSnapshot(db, snapshot, now)

    return {
      marked: snapshot.expiredAt === null,
      snapshot: updatedSnapshot,
    }
  }

  const updatedSnapshot = await transitionTaskSnapshot(
    db,
    snapshot.taskId,
    createExpiredTransition({ updatedAt: now.toISOString(), expiredAt: now.toISOString() })
  )

  return {
    marked: true,
    snapshot: updatedSnapshot ?? snapshot,
  }
}

export async function expireTaskIfPastBoundary(
  db: D1Database,
  snapshot: TaskSnapshot,
  now: Date
): Promise<TaskSnapshot> {
  if (snapshot.status === 'expired') {
    return snapshot
  }

  if (Date.parse(snapshot.expiresAt) > now.getTime()) {
    return snapshot
  }

  const expired = await transitionTaskSnapshot(
    db,
    snapshot.taskId,
    createExpiredTransition({ updatedAt: now.toISOString(), expiredAt: now.toISOString() })
  )

  return expired ?? snapshot
}

export async function getAccessibleTaskSnapshot(db: D1Database, taskId: string, now = new Date()): Promise<TaskSnapshot> {
  const snapshot = await findTaskSnapshotById(db, taskId)

  if (!snapshot) {
    throw new AppHttpError({
      status: 404,
      code: 'TASK_NOT_FOUND',
      message: 'Task was not found',
    })
  }

  const current = await expireTaskIfPastBoundary(db, snapshot, now)

  if (current.status === 'expired') {
    throw new AppHttpError({
      status: 410,
      code: 'TASK_EXPIRED',
      message: 'Task has expired',
    })
  }

  return current
}
