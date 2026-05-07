import type { TaskSnapshot } from './task-status'
import { bindSnapshotValues, rowToTaskSnapshot, type TaskRow } from './task-mapper'

export async function insertTaskSnapshot(db: D1Database, snapshot: TaskSnapshot): Promise<void> {
  await bindSnapshotValues(
    db.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at, expired_at,
        error_code, error_message, file_name, file_type, file_size_bytes, upload_id, upload_status,
        input_object_key, input_size_bytes, input_etag, input_content_type, input_part_count,
        input_checksum_sha256, output_object_key,
        output_content_type, output_size_bytes, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
        dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key,
        client_hash, client_user_agent, client_ip_hash, ga_client_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    snapshot
  ).run()
}

export async function findTaskSnapshotById(db: D1Database, taskId: string): Promise<TaskSnapshot | null> {
  const row = await db
    .prepare('SELECT * FROM parseotter_tasks WHERE task_id = ?')
    .bind(taskId)
    .first<TaskRow>()

  return row ? rowToTaskSnapshot(row) : null
}

function normalizeListLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return 100
  }

  return Math.min(limit, 500)
}

export async function listExpiredTaskSnapshots(
  db: D1Database,
  now: Date,
  limit = 100
): Promise<TaskSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT * FROM parseotter_tasks
       WHERE expires_at <= ?
         AND (status != ? OR input_object_key IS NOT NULL OR output_object_key IS NOT NULL)
       ORDER BY expires_at ASC
       LIMIT ?`
    )
    .bind(now.toISOString(), 'expired', normalizeListLimit(limit))
    .all<TaskRow>()

  return result.results.map(rowToTaskSnapshot)
}

export async function clearTaskObjectKeyAfterCleanup(
  db: D1Database,
  input: {
    taskId: string
    field: 'input' | 'output'
    objectKey: string
    now?: Date
  }
): Promise<void> {
  const column = input.field === 'input' ? 'input_object_key' : 'output_object_key'
  await db
    .prepare(
      `UPDATE parseotter_tasks
       SET ${column} = NULL,
           updated_at = ?
       WHERE task_id = ? AND ${column} = ?`
    )
    .bind((input.now ?? new Date()).toISOString(), input.taskId, input.objectKey)
    .run()
}

export async function updateTaskSnapshotConditionally(
  db: D1Database,
  snapshot: TaskSnapshot,
  expectedVersion: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE parseotter_tasks SET
        status = ?,
        visible_status = ?,
        version = ?,
        attempt = ?,
        updated_at = ?,
        expired_at = ?,
        error_code = ?,
        error_message = ?,
        upload_id = ?,
        upload_status = ?,
        input_object_key = ?,
        input_size_bytes = ?,
        input_etag = ?,
        input_content_type = ?,
        input_part_count = ?,
        input_checksum_sha256 = ?,
        output_object_key = ?,
        output_content_type = ?,
        output_size_bytes = ?,
        dispatch_status = ?,
        dispatch_attempt = ?,
        dispatch_idempotency_key = ?,
        dispatch_started_at = ?,
        dispatch_completed_at = ?,
        last_callback_idempotency_key = ?,
        client_hash = ?,
        client_user_agent = ?,
        client_ip_hash = ?,
        ga_client_id = ?
      WHERE task_id = ? AND version = ?`
    )
    .bind(
      snapshot.status,
      snapshot.visibleStatus,
      snapshot.version,
      snapshot.attempt,
      snapshot.updatedAt,
      snapshot.expiredAt,
      snapshot.errorCode,
      snapshot.errorMessage,
      snapshot.uploadId,
      snapshot.uploadStatus,
      snapshot.inputObjectKey,
      snapshot.inputSizeBytes,
      snapshot.inputEtag,
      snapshot.inputContentType,
      snapshot.inputPartCount,
      snapshot.inputChecksumSha256,
      snapshot.outputObjectKey,
      snapshot.outputContentType,
      snapshot.outputSizeBytes,
      snapshot.dispatchStatus,
      snapshot.dispatchAttempt,
      snapshot.dispatchIdempotencyKey,
      snapshot.dispatchStartedAt,
      snapshot.dispatchCompletedAt,
      snapshot.lastCallbackIdempotencyKey,
      snapshot.clientHash,
      snapshot.clientUserAgent,
      snapshot.clientIpHash,
      snapshot.gaClientId,
      snapshot.taskId,
      expectedVersion
    )
    .run()

  return result.meta.changes === 1
}
