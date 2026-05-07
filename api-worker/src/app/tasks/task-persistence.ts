import { calculateMultipartPartCount } from './multipart-plan'
import { createModalCallbackIdempotencyKey } from './modal-callback-idempotency'
import { findTaskSnapshotById, updateTaskSnapshotConditionally } from './task-queries'
import {
  mapInternalStatusToVisibleStatus,
  type TaskErrorCode,
  type TaskSnapshot,
} from './task-status'

export async function persistTaskUploadSession(
  db: D1Database,
  input: {
    snapshot: TaskSnapshot
    uploadId: string
    inputObjectKey: string
    now?: Date
  }
): Promise<{ persisted: boolean; snapshot: TaskSnapshot | null }> {
  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...input.snapshot,
    status: 'upload_pending',
    visibleStatus: mapInternalStatusToVisibleStatus('upload_pending'),
    version: input.snapshot.version + 1,
    updatedAt,
    errorCode: null,
    errorMessage: null,
    uploadId: input.uploadId,
    uploadStatus: 'pending',
    inputObjectKey: input.inputObjectKey,
    inputSizeBytes: null,
    inputEtag: null,
    inputContentType: input.snapshot.fileType,
    inputPartCount: null,
    inputChecksumSha256: null,
  }

  const updated = await updateTaskSnapshotConditionally(db, nextSnapshot, input.snapshot.version)
  if (updated) {
    return {
      persisted: true,
      snapshot: nextSnapshot,
    }
  }

  const currentSnapshot = await findTaskSnapshotById(db, input.snapshot.taskId)

  return {
    persisted: false,
    snapshot: currentSnapshot,
  }
}

export async function persistCompletedTaskUpload(
  db: D1Database,
  input: {
    snapshot: TaskSnapshot
    object: R2Object
    now?: Date
  }
): Promise<{ persisted: boolean; snapshot: TaskSnapshot | null }> {
  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...input.snapshot,
    status: 'upload_completed',
    visibleStatus: mapInternalStatusToVisibleStatus('upload_completed'),
    version: input.snapshot.version + 1,
    updatedAt,
    errorCode: null,
    errorMessage: null,
    uploadStatus: 'completed',
    inputSizeBytes: input.object.size,
    inputEtag: input.object.etag,
    inputContentType: input.object.httpMetadata?.contentType ?? input.snapshot.inputContentType ?? input.snapshot.fileType,
    inputPartCount: calculateMultipartPartCount(input.object.size),
    inputChecksumSha256: input.object.checksums.toJSON().sha256 ?? null,
  }

  const updated = await updateTaskSnapshotConditionally(db, nextSnapshot, input.snapshot.version)
  if (updated) {
    return {
      persisted: true,
      snapshot: nextSnapshot,
    }
  }

  const currentSnapshot = await findTaskSnapshotById(db, input.snapshot.taskId)

  return {
    persisted: false,
    snapshot: currentSnapshot,
  }
}

export async function persistFailedTaskUpload(
  db: D1Database,
  input: {
    snapshot: TaskSnapshot
    errorCode: Extract<TaskErrorCode, 'UPLOAD_ABORTED' | 'UPLOAD_FAILED'>
    errorMessage: string
    uploadStatus: string
    now?: Date
  }
): Promise<{ persisted: boolean; snapshot: TaskSnapshot | null }> {
  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...input.snapshot,
    status: 'failed',
    visibleStatus: mapInternalStatusToVisibleStatus('failed'),
    version: input.snapshot.version + 1,
    updatedAt,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    uploadStatus: input.uploadStatus,
  }

  const updated = await updateTaskSnapshotConditionally(db, nextSnapshot, input.snapshot.version)
  if (updated) {
    return {
      persisted: true,
      snapshot: nextSnapshot,
    }
  }

  const currentSnapshot = await findTaskSnapshotById(db, input.snapshot.taskId)

  return {
    persisted: false,
    snapshot: currentSnapshot,
  }
}

export async function persistAbortedTaskUpload(
  db: D1Database,
  input: {
    snapshot: TaskSnapshot
    now?: Date
  }
): Promise<{ persisted: boolean; snapshot: TaskSnapshot | null }> {
  return persistFailedTaskUpload(db, {
    snapshot: input.snapshot,
    errorCode: 'UPLOAD_ABORTED',
    errorMessage: 'Upload was aborted',
    uploadStatus: 'aborted',
    now: input.now,
  })
}

function isCallbackProtectedTerminalSnapshot(snapshot: TaskSnapshot): boolean {
  return snapshot.status === 'succeeded' || snapshot.status === 'failed' || snapshot.status === 'expired'
}

function isExpectedModalCallbackForCurrentDispatch(
  snapshot: TaskSnapshot,
  input: {
    attempt: number
    idempotencyKey: string
  }
): boolean {
  if (snapshot.status !== 'dispatching' && snapshot.status !== 'processing') {
    return false
  }

  if (snapshot.dispatchStatus !== 'dispatching' && snapshot.dispatchStatus !== 'dispatched') {
    return false
  }

  return (
    input.attempt === snapshot.dispatchAttempt &&
    input.idempotencyKey === createModalCallbackIdempotencyKey(snapshot.taskId, snapshot.dispatchAttempt)
  )
}

async function persistModalSnapshot(
  db: D1Database,
  snapshot: TaskSnapshot,
  expectedVersion: number
): Promise<TaskSnapshot | null> {
  const updated = await updateTaskSnapshotConditionally(db, snapshot, expectedVersion)
  if (updated) {
    return snapshot
  }

  return findTaskSnapshotById(db, snapshot.taskId)
}

export async function persistDispatchedTask(
  db: D1Database,
  input: {
    snapshot: TaskSnapshot
    now?: Date
  }
): Promise<TaskSnapshot | null> {
  if (input.snapshot.status !== 'dispatching') {
    return input.snapshot
  }

  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...input.snapshot,
    status: 'processing',
    visibleStatus: mapInternalStatusToVisibleStatus('processing'),
    version: input.snapshot.version + 1,
    updatedAt,
    errorCode: null,
    errorMessage: null,
    dispatchStatus: 'dispatched',
    dispatchCompletedAt: updatedAt,
  }

  return persistModalSnapshot(db, nextSnapshot, input.snapshot.version)
}

export async function persistModalDispatchFailed(
  db: D1Database,
  input: {
    snapshot: TaskSnapshot
    errorMessage?: string | null
    now?: Date
  }
): Promise<TaskSnapshot | null> {
  if (isCallbackProtectedTerminalSnapshot(input.snapshot)) {
    return input.snapshot
  }

  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...input.snapshot,
    status: 'failed',
    visibleStatus: mapInternalStatusToVisibleStatus('failed'),
    version: input.snapshot.version + 1,
    updatedAt,
    errorCode: 'MODAL_DISPATCH_FAILED',
    errorMessage: input.errorMessage ?? 'Modal dispatch failed',
    dispatchStatus: 'failed',
    dispatchCompletedAt: updatedAt,
  }

  return persistModalSnapshot(db, nextSnapshot, input.snapshot.version)
}

export async function persistModalSucceededCallback(
  db: D1Database,
  input: {
    taskId: string
    attempt: number
    outputObjectKey: string
    outputContentType: string
    outputSizeBytes: number
    idempotencyKey: string
    now?: Date
  }
): Promise<TaskSnapshot | null> {
  const current = await findTaskSnapshotById(db, input.taskId)
  if (!current) {
    return null
  }

  if (isCallbackProtectedTerminalSnapshot(current)) {
    return current
  }

  if (!isExpectedModalCallbackForCurrentDispatch(current, input)) {
    return null
  }

  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...current,
    status: 'succeeded',
    visibleStatus: mapInternalStatusToVisibleStatus('succeeded'),
    version: current.version + 1,
    attempt: input.attempt,
    updatedAt,
    errorCode: null,
    errorMessage: null,
    outputObjectKey: input.outputObjectKey,
    outputContentType: input.outputContentType,
    outputSizeBytes: input.outputSizeBytes,
    dispatchStatus: 'completed',
    dispatchCompletedAt: updatedAt,
    lastCallbackIdempotencyKey: input.idempotencyKey,
  }

  return persistModalSnapshot(db, nextSnapshot, current.version)
}

export async function persistModalFailedCallback(
  db: D1Database,
  input: {
    taskId: string
    attempt: number
    errorMessage?: string | null
    idempotencyKey: string
    now?: Date
  }
): Promise<TaskSnapshot | null> {
  const current = await findTaskSnapshotById(db, input.taskId)
  if (!current) {
    return null
  }

  if (isCallbackProtectedTerminalSnapshot(current)) {
    return current
  }

  if (!isExpectedModalCallbackForCurrentDispatch(current, input)) {
    return null
  }

  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...current,
    status: 'failed',
    visibleStatus: mapInternalStatusToVisibleStatus('failed'),
    version: current.version + 1,
    attempt: input.attempt,
    updatedAt,
    errorCode: 'MODAL_PROCESSING_FAILED',
    errorMessage: input.errorMessage ?? 'Modal processing failed',
    dispatchStatus: 'completed',
    dispatchCompletedAt: updatedAt,
    lastCallbackIdempotencyKey: input.idempotencyKey,
  }

  return persistModalSnapshot(db, nextSnapshot, current.version)
}

export async function persistRecoveredTaskSuccess(
  db: D1Database,
  input: {
    taskId: string
    outputObjectKey: string
    outputContentType: string
    outputSizeBytes: number
    now?: Date
  }
): Promise<TaskSnapshot | null> {
  const current = await findTaskSnapshotById(db, input.taskId)
  if (!current) {
    return null
  }

  if (isCallbackProtectedTerminalSnapshot(current)) {
    return current
  }

  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...current,
    status: 'succeeded',
    visibleStatus: mapInternalStatusToVisibleStatus('succeeded'),
    version: current.version + 1,
    updatedAt,
    errorCode: null,
    errorMessage: null,
    outputObjectKey: input.outputObjectKey,
    outputContentType: input.outputContentType,
    outputSizeBytes: input.outputSizeBytes,
    dispatchStatus: 'completed',
    dispatchCompletedAt: updatedAt,
  }

  return persistModalSnapshot(db, nextSnapshot, current.version)
}

export async function persistProcessingTimeoutFailure(
  db: D1Database,
  input: {
    taskId: string
    errorMessage?: string | null
    now?: Date
  }
): Promise<TaskSnapshot | null> {
  const current = await findTaskSnapshotById(db, input.taskId)
  if (!current) {
    return null
  }

  if (isCallbackProtectedTerminalSnapshot(current)) {
    return current
  }

  const updatedAt = (input.now ?? new Date()).toISOString()
  const nextSnapshot: TaskSnapshot = {
    ...current,
    status: 'failed',
    visibleStatus: mapInternalStatusToVisibleStatus('failed'),
    version: current.version + 1,
    updatedAt,
    errorCode: 'PROCESSING_TIMEOUT',
    errorMessage: input.errorMessage ?? 'Task exceeded the processing timeout window',
    dispatchStatus: 'failed',
    dispatchCompletedAt: updatedAt,
  }

  return persistModalSnapshot(db, nextSnapshot, current.version)
}
