import { readAbuseLimitingEnabled } from '../abuse/abuse-config'
import { assertDispatchMayStart, incrementDispatchUsage } from '../abuse/usage'
import { claimDispatchPendingTask, listDispatchPendingSnapshots } from './dispatch-outbox'
import { createModalCallbackIdempotencyKey } from './modal-callback-idempotency'
import { persistDispatchedTask, persistModalDispatchFailed } from './task-record'
import type { TaskSnapshot } from './task-status'

export const PARSEOTTER_FREE_OUTPUT_PROFILE = 'parseotter_free_v1'
export const PARSEOTTER_FREE_USER_ID = 'parseotter_free'
export const MODAL_CALLBACK_SIGNATURE_HEADER = 'X-Modal-Signature'

type ModalDispatchPayload = {
  jobId: string
  userId: string
  attempt: number
  input: {
    objectKey: string
    contentType: string
    sizeBytes: number
    checksumSha256: string | null
  }
  output: {
    objectKey: string
    format: 'zip'
  }
  options: {
    enable_translation: false
    target_language: ''
    output_profile: typeof PARSEOTTER_FREE_OUTPUT_PROFILE
  }
  targetLanguage: ''
  callback: {
    url: string | null
    authHeaderName: typeof MODAL_CALLBACK_SIGNATURE_HEADER
    idempotencyKey: string
  }
}

type ModalDispatchEnv = Partial<CloudflareBindings> & {
  BACKEND_PUBLIC_ORIGIN?: string
}

function readOptionalEnvString(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveCallbackOrigin(input: { callbackOrigin: string | null; env: ModalDispatchEnv }): string | null {
  return input.callbackOrigin ?? readOptionalEnvString(input.env.BACKEND_PUBLIC_ORIGIN)
}

function createModalCallbackUrl(origin: string | null): string | null {
  if (!origin) {
    return null
  }

  try {
    const url = new URL('/api/internal/modal/callback', origin)
    return url.toString()
  } catch {
    return null
  }
}

export function createOutputObjectKey(taskId: string): string {
  return `parseotter/${taskId}/output/result.zip`
}

function createDispatchPayload(input: {
  snapshot: TaskSnapshot
  callbackOrigin: string | null
}): ModalDispatchPayload | null {
  const snapshot = input.snapshot
  if (
    snapshot.inputObjectKey === null ||
    snapshot.inputSizeBytes === null ||
    snapshot.dispatchIdempotencyKey === null
  ) {
    return null
  }

  return {
    jobId: snapshot.taskId,
    userId: PARSEOTTER_FREE_USER_ID,
    attempt: snapshot.dispatchAttempt,
    input: {
      objectKey: snapshot.inputObjectKey,
      contentType: snapshot.inputContentType ?? snapshot.fileType,
      sizeBytes: snapshot.inputSizeBytes,
      checksumSha256: snapshot.inputChecksumSha256,
    },
    output: {
      objectKey: createOutputObjectKey(snapshot.taskId),
      format: 'zip',
    },
    options: {
      enable_translation: false,
      target_language: '',
      output_profile: PARSEOTTER_FREE_OUTPUT_PROFILE,
    },
    targetLanguage: '',
    callback: {
      url: createModalCallbackUrl(input.callbackOrigin),
      authHeaderName: MODAL_CALLBACK_SIGNATURE_HEADER,
      idempotencyKey: createModalCallbackIdempotencyKey(snapshot.taskId, snapshot.dispatchAttempt),
    },
  }
}

function normalizeModalDispatchFailureDetail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized.slice(0, 240) : null
}

async function createModalDispatchHttpFailureMessage(response: Response): Promise<string> {
  let detail: string | null = null

  try {
    const body = (await response.clone().json()) as unknown
    if (body && typeof body === 'object') {
      const fields = body as Record<string, unknown>
      detail =
        normalizeModalDispatchFailureDetail(fields.detail) ??
        normalizeModalDispatchFailureDetail(fields.message) ??
        normalizeModalDispatchFailureDetail(fields.error)
    }
  } catch {
    try {
      detail = normalizeModalDispatchFailureDetail(await response.clone().text())
    } catch {
      detail = null
    }
  }

  return detail ? `Modal dispatch failed: HTTP ${response.status} ${detail}` : `Modal dispatch failed: HTTP ${response.status}`
}

async function failDispatch(input: {
  db: D1Database
  snapshot: TaskSnapshot
  message?: string
  now?: Date
}): Promise<TaskSnapshot> {
  const failed = await persistModalDispatchFailed(input.db, {
    snapshot: input.snapshot,
    errorMessage: input.message ?? 'Modal dispatch failed',
    now: input.now,
  })

  return failed ?? input.snapshot
}

export async function dispatchModalForPendingTask(input: {
  db: D1Database
  env: ModalDispatchEnv
  taskId: string
  callbackOrigin: string | null
  now?: Date
}): Promise<TaskSnapshot | null> {
  const canDispatch = await assertDispatchMayStart({
    db: input.db,
    env: input.env,
    now: input.now,
  })
  if (!canDispatch) {
    return null
  }

  const claimed = await claimDispatchPendingTask(input.db, input.taskId, input.now)
  const claimedSnapshot = claimed.snapshot
  if (!claimed.claimed || !claimedSnapshot) {
    return claimedSnapshot
  }

  const dispatchUrl = readOptionalEnvString(input.env.MODAL_DISPATCH_URL)
  if (!dispatchUrl) {
    return failDispatch({
      db: input.db,
      snapshot: claimedSnapshot,
      now: input.now,
    })
  }

  const dispatchApiKey = readOptionalEnvString(input.env.MODAL_DISPATCH_API_KEY)
  const payload = createDispatchPayload({
    snapshot: claimedSnapshot,
    callbackOrigin: resolveCallbackOrigin({
      callbackOrigin: input.callbackOrigin,
      env: input.env,
    }),
  })
  if (!dispatchApiKey || !payload || claimedSnapshot.dispatchIdempotencyKey === null) {
    return failDispatch({
      db: input.db,
      snapshot: claimedSnapshot,
      now: input.now,
    })
  }

  try {
    const response = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': dispatchApiKey,
        'x-idempotency-key': claimedSnapshot.dispatchIdempotencyKey,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const message = await createModalDispatchHttpFailureMessage(response)
      return failDispatch({
        db: input.db,
        snapshot: claimedSnapshot,
        message,
        now: input.now,
      })
    }

    const dispatched =
      (await persistDispatchedTask(input.db, {
        snapshot: claimedSnapshot,
        now: input.now,
      })) ?? claimedSnapshot

    if (
      readAbuseLimitingEnabled(input.env) &&
      dispatched.status === 'processing' &&
      dispatched.dispatchStatus === 'dispatched'
    ) {
      await incrementDispatchUsage(input.db, {
        clientHash: dispatched.clientHash,
        now: input.now,
      })
    }

    return dispatched
  } catch {
    return failDispatch({
      db: input.db,
      snapshot: claimedSnapshot,
      now: input.now,
    })
  }
}

export async function dispatchPendingTasks(input: {
  db: D1Database
  env: ModalDispatchEnv
  now?: Date
  limit?: number
}): Promise<{
  scanned: number
  dispatched: number
  markedFailed: number
  failures: number
}> {
  const now = input.now ?? new Date()
  const pendingTasks = await listDispatchPendingSnapshots(input.db, now, input.limit ?? 100)
  let dispatched = 0
  let markedFailed = 0
  let failures = 0

  for (const snapshot of pendingTasks) {
    try {
      const result = await dispatchModalForPendingTask({
        db: input.db,
        env: input.env,
        taskId: snapshot.taskId,
        callbackOrigin: null,
        now,
      })

      if (result?.status === 'processing' && result.dispatchStatus === 'dispatched') {
        dispatched += 1
      }

      if (result?.errorCode === 'MODAL_DISPATCH_FAILED') {
        markedFailed += 1
      }
    } catch {
      failures += 1
    }
  }

  return {
    scanned: pendingTasks.length,
    dispatched,
    markedFailed,
    failures,
  }
}
