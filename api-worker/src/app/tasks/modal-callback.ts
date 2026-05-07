import { isJsonObject } from '../../lib/json'
import { AppHttpError } from '../http/errors'
import { createRequestValidationError, type ValidationIssue } from '../http/validation'
import { readModalCallbackToleranceSeconds } from '../runtime-config'
import { verifyModalCallbackSignature } from '../security/modal-callback-signature'
import { createModalCallbackIdempotencyKey } from './modal-callback-idempotency'
import { createOutputObjectKey } from './modal-dispatch'
import {
  getAccessibleTaskSnapshot,
  persistModalFailedCallback,
  persistModalSucceededCallback,
} from './task-record'
import { isTerminalTaskStatus, type TaskSnapshot } from './task-status'

export type ModalCallbackRequest =
  | {
      taskId: string
      jobId: string
      status: 'completed'
      outputObjectKey: string
      outputContentType: string | null
      attempt: number
      idempotencyKey: string
    }
  | {
      taskId: string
      jobId: string
      status: 'failed'
      errorCode: string | null
      errorMessage: string | null
      attempt: number
      idempotencyKey: string
    }

function createCallbackUnauthorizedError(): AppHttpError {
  return new AppHttpError({
    status: 401,
    code: 'CALLBACK_UNAUTHORIZED',
    message: 'Modal callback is unauthorized',
  })
}

function createCallbackStateConflictError(input: {
  reason: string
  snapshot: TaskSnapshot
  callback: ModalCallbackRequest
}): AppHttpError {
  return new AppHttpError({
    status: 409,
    code: 'CALLBACK_STATE_CONFLICT',
    message: 'Modal callback does not match the current dispatch state',
    details: {
      reason: input.reason,
      current: {
        status: input.snapshot.status,
        dispatchStatus: input.snapshot.dispatchStatus,
        dispatchAttempt: input.snapshot.dispatchAttempt,
      },
      received: {
        status: input.callback.status,
        attempt: input.callback.attempt,
      },
    },
  })
}

function assertCallbackMatchesCurrentDispatch(snapshot: TaskSnapshot, callback: ModalCallbackRequest): void {
  if (snapshot.status !== 'dispatching' && snapshot.status !== 'processing') {
    throw createCallbackStateConflictError({
      reason: 'TASK_NOT_AWAITING_MODAL_CALLBACK',
      snapshot,
      callback,
    })
  }

  if (snapshot.dispatchStatus !== 'dispatching' && snapshot.dispatchStatus !== 'dispatched') {
    throw createCallbackStateConflictError({
      reason: 'DISPATCH_NOT_AWAITING_MODAL_CALLBACK',
      snapshot,
      callback,
    })
  }

  if (callback.attempt !== snapshot.dispatchAttempt) {
    throw createCallbackStateConflictError({
      reason: 'ATTEMPT_MISMATCH',
      snapshot,
      callback,
    })
  }

  const expectedIdempotencyKey = createModalCallbackIdempotencyKey(
    snapshot.taskId,
    snapshot.dispatchAttempt
  )
  if (callback.idempotencyKey !== expectedIdempotencyKey) {
    throw createCallbackStateConflictError({
      reason: 'IDEMPOTENCY_KEY_MISMATCH',
      snapshot,
      callback,
    })
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readAttempt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseJsonBody(body: string): Record<string, unknown> {
  let payload: unknown

  try {
    payload = JSON.parse(body)
  } catch {
    throw createRequestValidationError([
      {
        field: 'body',
        code: 'invalid_json',
        message: 'Request body must be valid JSON',
      },
    ])
  }

  if (!isJsonObject(payload)) {
    throw createRequestValidationError([
      {
        field: 'body',
        code: 'invalid_type',
        message: 'Request body must be a JSON object',
      },
    ])
  }

  return payload
}

export function parseModalCallbackRequest(body: string): ModalCallbackRequest {
  const payload = parseJsonBody(body)
  const issues: ValidationIssue[] = []
  const taskId = readString(payload.taskId) ?? readString(payload.jobId)
  const jobId = readString(payload.jobId) ?? taskId
  const status = payload.status
  const attempt = readAttempt(payload.attempt)
  const idempotencyKey = readString(payload.idempotencyKey)

  if (!taskId) {
    issues.push({ field: 'taskId', code: 'invalid_type', message: 'taskId is required' })
  }

  if (!jobId) {
    issues.push({ field: 'jobId', code: 'invalid_type', message: 'jobId is required' })
  }

  if (status !== 'completed' && status !== 'failed') {
    issues.push({ field: 'status', code: 'invalid_value', message: 'status must be completed or failed' })
  }

  if (attempt === null) {
    issues.push({ field: 'attempt', code: 'invalid_integer', message: 'attempt must be a positive integer' })
  }

  if (!idempotencyKey) {
    issues.push({
      field: 'idempotencyKey',
      code: 'invalid_type',
      message: 'idempotencyKey is required',
    })
  }

  if (issues.length > 0 || !taskId || !jobId || attempt === null || !idempotencyKey) {
    throw createRequestValidationError(issues)
  }

  if (status === 'completed') {
    const outputObjectKey = readString(payload.outputObjectKey)
    if (!outputObjectKey) {
      throw createRequestValidationError([
        {
          field: 'outputObjectKey',
          code: 'invalid_type',
          message: 'outputObjectKey is required for completed callbacks',
        },
      ])
    }

    return {
      taskId,
      jobId,
      status,
      outputObjectKey,
      outputContentType: readNullableString(payload.outputContentType),
      attempt,
      idempotencyKey,
    }
  }

  return {
    taskId,
    jobId,
    status: 'failed',
    errorCode: readNullableString(payload.errorCode),
    errorMessage: readNullableString(payload.errorMessage),
    attempt,
    idempotencyKey,
  }
}

export async function verifyModalCallbackRequest(input: {
  body: string
  headers: Headers
  env: Partial<CloudflareBindings>
}): Promise<void> {
  const timestamp = input.headers.get('x-modal-timestamp')
  const signature = input.headers.get('x-modal-signature')

  if (!timestamp || !signature) {
    throw createCallbackUnauthorizedError()
  }

  const result = await verifyModalCallbackSignature({
    body: input.body,
    secret: input.env.MODAL_CALLBACK_HMAC_SECRET ?? '',
    timestamp,
    signature,
    toleranceSeconds: readModalCallbackToleranceSeconds(input.env),
  })

  if (!result.valid) {
    throw createCallbackUnauthorizedError()
  }
}

export async function applyModalCallback(input: {
  db: D1Database
  bucket: R2Bucket
  callback: ModalCallbackRequest
}): Promise<TaskSnapshot> {
  const snapshot = await getAccessibleTaskSnapshot(input.db, input.callback.taskId)

  if (isTerminalTaskStatus(snapshot.status)) {
    return snapshot
  }

  assertCallbackMatchesCurrentDispatch(snapshot, input.callback)

  if (input.callback.status === 'failed') {
    const failed = await persistModalFailedCallback(input.db, {
      taskId: input.callback.taskId,
      attempt: input.callback.attempt,
      errorMessage: input.callback.errorMessage,
      idempotencyKey: input.callback.idempotencyKey,
    })

    if (!failed) {
      throw createCallbackStateConflictError({
        reason: 'CURRENT_DISPATCH_CHANGED',
        snapshot,
        callback: input.callback,
      })
    }

    return failed
  }

  const expectedOutputObjectKey = createOutputObjectKey(input.callback.taskId)
  if (input.callback.outputObjectKey !== expectedOutputObjectKey) {
    throw createRequestValidationError([
      {
        field: 'outputObjectKey',
        code: 'invalid_value',
        message: 'outputObjectKey does not belong to this task',
      },
    ])
  }

  const outputObject = await input.bucket.head(input.callback.outputObjectKey)
  if (!outputObject) {
    throw new AppHttpError({
      status: 404,
      code: 'RESULT_NOT_FOUND',
      message: 'Result object was not found',
    })
  }

  const succeeded = await persistModalSucceededCallback(input.db, {
    taskId: input.callback.taskId,
    attempt: input.callback.attempt,
    outputObjectKey: input.callback.outputObjectKey,
    outputContentType:
      outputObject.httpMetadata?.contentType ?? input.callback.outputContentType ?? 'application/zip',
    outputSizeBytes: outputObject.size,
    idempotencyKey: input.callback.idempotencyKey,
  })

  if (!succeeded) {
    throw createCallbackStateConflictError({
      reason: 'CURRENT_DISPATCH_CHANGED',
      snapshot,
      callback: input.callback,
    })
  }

  return succeeded
}
