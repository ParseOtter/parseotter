import { readTaskRetentionHours } from '../runtime-config'
import {
  mapInternalStatusToVisibleStatus,
  type InternalTaskStatus,
  type TaskErrorCode,
  type TaskSnapshot,
} from './task-status'

export type TaskRow = {
  task_id: string
  status: InternalTaskStatus
  visible_status: TaskSnapshot['visibleStatus']
  version: number
  attempt: number
  created_at: string
  updated_at: string
  expires_at: string
  expired_at: string | null
  error_code: TaskErrorCode | null
  error_message: string | null
  file_name: string
  file_type: string
  file_size_bytes: number
  upload_id: string | null
  upload_status: string | null
  input_object_key: string | null
  input_size_bytes: number | null
  input_etag: string | null
  input_content_type: string | null
  input_part_count: number | null
  input_checksum_sha256: string | null
  output_object_key: string | null
  output_content_type: string | null
  output_size_bytes: number | null
  dispatch_status: string | null
  dispatch_attempt: number
  dispatch_idempotency_key: string | null
  dispatch_started_at: string | null
  dispatch_completed_at: string | null
  last_callback_idempotency_key: string | null
  client_hash: string | null
  client_user_agent: string | null
  client_ip_hash: string | null
  ga_client_id: string | null
}

export type CreateTaskRecordInput = {
  taskId: string
  fileName: string
  fileType: string
  fileSizeBytes: number
  clientHash?: string | null
  clientUserAgent?: string | null
  clientIpHash?: string | null
  gaClientId?: string | null
  now?: Date
  env?: Partial<CloudflareBindings>
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000)
}

export function rowToTaskSnapshot(row: TaskRow): TaskSnapshot {
  return {
    taskId: row.task_id,
    status: row.status,
    visibleStatus: row.visible_status,
    version: row.version,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    expiredAt: row.expired_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSizeBytes: row.file_size_bytes,
    uploadId: row.upload_id,
    uploadStatus: row.upload_status,
    inputObjectKey: row.input_object_key,
    inputSizeBytes: row.input_size_bytes,
    inputEtag: row.input_etag,
    inputContentType: row.input_content_type,
    inputPartCount: row.input_part_count,
    inputChecksumSha256: row.input_checksum_sha256,
    outputObjectKey: row.output_object_key,
    outputContentType: row.output_content_type,
    outputSizeBytes: row.output_size_bytes,
    dispatchStatus: row.dispatch_status,
    dispatchAttempt: row.dispatch_attempt,
    dispatchIdempotencyKey: row.dispatch_idempotency_key,
    dispatchStartedAt: row.dispatch_started_at,
    dispatchCompletedAt: row.dispatch_completed_at,
    lastCallbackIdempotencyKey: row.last_callback_idempotency_key,
    clientHash: row.client_hash,
    clientUserAgent: row.client_user_agent,
    clientIpHash: row.client_ip_hash,
    gaClientId: row.ga_client_id,
  }
}

export function bindSnapshotValues(statement: D1PreparedStatement, snapshot: TaskSnapshot): D1PreparedStatement {
  return statement.bind(
    snapshot.taskId,
    snapshot.status,
    snapshot.visibleStatus,
    snapshot.version,
    snapshot.attempt,
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.expiresAt,
    snapshot.expiredAt,
    snapshot.errorCode,
    snapshot.errorMessage,
    snapshot.fileName,
    snapshot.fileType,
    snapshot.fileSizeBytes,
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
    snapshot.gaClientId
  )
}

export function createInitialTaskSnapshot(input: CreateTaskRecordInput): TaskSnapshot {
  const now = input.now ?? new Date()
  const createdAt = now.toISOString()
  const expiresAt = addHours(now, readTaskRetentionHours(input.env)).toISOString()

  return {
    taskId: input.taskId,
    status: 'created',
    visibleStatus: mapInternalStatusToVisibleStatus('created'),
    version: 1,
    attempt: 0,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    expiredAt: null,
    errorCode: null,
    errorMessage: null,
    fileName: input.fileName,
    fileType: input.fileType,
    fileSizeBytes: input.fileSizeBytes,
    uploadId: null,
    uploadStatus: null,
    inputObjectKey: null,
    inputSizeBytes: null,
    inputEtag: null,
    inputContentType: null,
    inputPartCount: null,
    inputChecksumSha256: null,
    outputObjectKey: null,
    outputContentType: null,
    outputSizeBytes: null,
    dispatchStatus: null,
    dispatchAttempt: 0,
    dispatchIdempotencyKey: null,
    dispatchStartedAt: null,
    dispatchCompletedAt: null,
    lastCallbackIdempotencyKey: null,
    clientHash: input.clientHash ?? null,
    clientUserAgent: input.clientUserAgent ?? null,
    clientIpHash: input.clientIpHash ?? null,
    gaClientId: input.gaClientId ?? null,
  }
}
