import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../../src/worker'
import { cleanupExpiredTasks } from '../../src/app/tasks/expired-cleanup'
import { resetTaskDatabase } from '../support/task-db'

const scheduledAt = new Date('2026-04-25T00:00:00.000Z')
const MODAL_DISPATCH_URL = 'https://modal.example.test/api/internal/cloudflare/jobs/dispatch'
const MODAL_DISPATCH_API_KEY = 'modal-api-key'
const BACKEND_PUBLIC_ORIGIN = 'https://your-backend.workers.dev'

type TestBackendOriginEnv = {
  BACKEND_PUBLIC_ORIGIN?: string
}

const ORIGINAL_ENV = {
  MODAL_DISPATCH_URL: env.MODAL_DISPATCH_URL,
  MODAL_DISPATCH_API_KEY: env.MODAL_DISPATCH_API_KEY,
  PROCESSING_TIMEOUT_SECONDS: env.PROCESSING_TIMEOUT_SECONDS,
  BACKEND_PUBLIC_ORIGIN: (env as TestBackendOriginEnv).BACKEND_PUBLIC_ORIGIN,
}

type DispatchFetchCall = {
  request: Request
  body: Record<string, unknown>
}

async function insertExpiredTask(input: {
  taskId: string
  status?: string
  visibleStatus?: string
  inputObjectKey?: string | null
  outputObjectKey?: string | null
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO parseotter_tasks (
      task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
      file_name, file_type, file_size_bytes, input_object_key, output_object_key, dispatch_attempt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.taskId,
      input.status ?? 'processing',
      input.visibleStatus ?? 'Converting',
      1,
      1,
      '2026-04-20T00:00:00.000Z',
      '2026-04-20T00:00:00.000Z',
      '2026-04-22T00:00:00.000Z',
      'expired.pdf',
      'application/pdf',
      123,
      input.inputObjectKey ?? null,
      input.outputObjectKey ?? null,
      0
    )
    .run()
}

async function readTaskStatus(taskId: string): Promise<{
  status: string
  visible_status: string
  expired_at: string | null
  error_code: string | null
  input_object_key: string | null
  output_object_key: string | null
  output_content_type: string | null
  output_size_bytes: number | null
  last_callback_idempotency_key: string | null
}> {
  const row = await env.DB.prepare(
    `SELECT status, visible_status, expired_at, error_code,
            input_object_key, output_object_key, output_content_type, output_size_bytes, last_callback_idempotency_key
     FROM parseotter_tasks WHERE task_id = ?`
  )
    .bind(taskId)
    .first<{
      status: string
      visible_status: string
      expired_at: string | null
      error_code: string | null
      input_object_key: string | null
      output_object_key: string | null
      output_content_type: string | null
      output_size_bytes: number | null
      last_callback_idempotency_key: string | null
    }>()

  if (!row) {
    throw new Error(`Task ${taskId} was not found`)
  }

  return row
}

function restoreScheduledTestEnv(): void {
  Object.assign(env, {
    MODAL_DISPATCH_URL: ORIGINAL_ENV.MODAL_DISPATCH_URL,
    MODAL_DISPATCH_API_KEY: ORIGINAL_ENV.MODAL_DISPATCH_API_KEY,
    PROCESSING_TIMEOUT_SECONDS: ORIGINAL_ENV.PROCESSING_TIMEOUT_SECONDS,
  })

  if (ORIGINAL_ENV.BACKEND_PUBLIC_ORIGIN === undefined) {
    delete (env as TestBackendOriginEnv).BACKEND_PUBLIC_ORIGIN
  } else {
    Object.assign(env, {
      BACKEND_PUBLIC_ORIGIN: ORIGINAL_ENV.BACKEND_PUBLIC_ORIGIN,
    })
  }
}

function configureDispatchEnv(input?: { dispatchUrl?: string; backendPublicOrigin?: string }): void {
  Object.assign(env, {
    MODAL_DISPATCH_URL: input?.dispatchUrl ?? MODAL_DISPATCH_URL,
    MODAL_DISPATCH_API_KEY,
    BACKEND_PUBLIC_ORIGIN: input?.backendPublicOrigin ?? BACKEND_PUBLIC_ORIGIN,
  })
}

function stubModalDispatch(status = 202): DispatchFetchCall[] {
  const calls: DispatchFetchCall[] = []

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = (await request.clone().json()) as Record<string, unknown>
    calls.push({
      request: request.clone(),
      body,
    })

    return Response.json(
      {
        accepted: status >= 200 && status < 300,
      },
      { status }
    )
  })

  return calls
}

async function insertDispatchTask(input: {
  taskId: string
  status: 'dispatch_pending' | 'dispatching' | 'processing'
  dispatchStatus: string
  dispatchStartedAt?: string | null
  dispatchCompletedAt?: string | null
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO parseotter_tasks (
      task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
      file_name, file_type, file_size_bytes, upload_status, input_object_key, input_size_bytes,
      input_content_type, input_part_count, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
      dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.taskId,
      input.status,
      'Converting',
      6,
      1,
      '2026-04-24T20:00:00.000Z',
      '2026-04-24T20:10:00.000Z',
      '2026-04-27T20:00:00.000Z',
      'scheduled-dispatch.pdf',
      'application/pdf',
      123,
      'completed',
      `parseotter/${input.taskId}/input/original.pdf`,
      123,
      'application/pdf',
      1,
      input.dispatchStatus,
      1,
      `${input.taskId}:dispatch:1`,
      input.dispatchStartedAt ?? null,
      input.dispatchCompletedAt ?? null,
      null
    )
    .run()
}

describe('expired task cleanup', () => {
  beforeEach(async () => {
    await resetTaskDatabase(env.DB)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreScheduledTestEnv()
  })

  it('marks expired tasks and deletes recorded R2 input/output objects from the scheduled handler', async () => {
    const taskId = 'task_cleanupabcdefghijklmnopqrstuvwxyz12'
    const inputObjectKey = `parseotter/${taskId}/input/original.pdf`
    const outputObjectKey = `parseotter/${taskId}/output/result.zip`

    await insertExpiredTask({ taskId, inputObjectKey, outputObjectKey })
    await env.R2_BUCKET.put(inputObjectKey, 'input')
    await env.R2_BUCKET.put(outputObjectKey, 'output')

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'expired',
      visible_status: 'Expired',
      expired_at: scheduledAt.toISOString(),
      error_code: 'TASK_EXPIRED',
    })
    await expect(env.R2_BUCKET.head(inputObjectKey)).resolves.toBeNull()
    await expect(env.R2_BUCKET.head(outputObjectKey)).resolves.toBeNull()

    const secondCtx = createExecutionContext()
    await worker.scheduled(controller, env, secondCtx)
    await waitOnExecutionContext(secondCtx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'expired',
      visible_status: 'Expired',
      error_code: 'TASK_EXPIRED',
    })
  })

  it('reconciles a stuck processing task to succeeded during the scheduled sweep when the output object exists', async () => {
    const taskId = 'task_reconcile_success_abcdefghijklmnopqrstuvwxyz'
    const outputObjectKey = `parseotter/${taskId}/output/result.zip`

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, upload_status, input_object_key, input_size_bytes,
        input_content_type, input_part_count, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
        dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        'processing',
        'Converting',
        6,
        1,
        '2026-04-24T23:00:00.000Z',
        '2026-04-24T23:10:00.000Z',
        '2026-04-27T23:00:00.000Z',
        'scheduled-success.pdf',
        'application/pdf',
        123,
        'completed',
        `parseotter/${taskId}/input/original.pdf`,
        123,
        'application/pdf',
        1,
        'dispatched',
        1,
        `${taskId}:dispatch:1`,
        '2026-04-24T23:05:00.000Z',
        '2026-04-24T23:10:00.000Z',
        null
      )
      .run()

    await env.R2_BUCKET.put(outputObjectKey, 'zip-output', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'succeeded',
      visible_status: 'Conversion complete',
      error_code: null,
      output_object_key: outputObjectKey,
      output_content_type: 'application/zip',
      output_size_bytes: 10,
      last_callback_idempotency_key: null,
    })
  })

  it('dispatches pending outbox tasks during the scheduled sweep', async () => {
    const taskId = 'task_scheduled_pending_dispatch_abcdefghi'
    configureDispatchEnv()
    const dispatchCalls = stubModalDispatch()
    await insertDispatchTask({
      taskId,
      status: 'dispatch_pending',
      dispatchStatus: 'pending',
    })

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0].request.url).toBe(MODAL_DISPATCH_URL)
    expect(dispatchCalls[0].request.headers.get('x-api-key')).toBe(MODAL_DISPATCH_API_KEY)
    expect(dispatchCalls[0].request.headers.get('x-idempotency-key')).toBe(`${taskId}:dispatch:1`)
    expect(dispatchCalls[0].body).toMatchObject({
      jobId: taskId,
      callback: {
        url: `${BACKEND_PUBLIC_ORIGIN}/api/internal/modal/callback`,
        idempotencyKey: `${taskId}:callback:1`,
      },
    })
    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'processing',
      visible_status: 'Converting',
      error_code: null,
    })
  })

  it('marks dispatch pending tasks failed during the scheduled sweep when Modal dispatch is not configured', async () => {
    const taskId = 'task_scheduled_pending_dispatch_no_url'
    configureDispatchEnv({ dispatchUrl: '' })
    await insertDispatchTask({
      taskId,
      status: 'dispatch_pending',
      dispatchStatus: 'pending',
    })

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'failed',
      visible_status: 'Conversion failed',
      error_code: 'MODAL_DISPATCH_FAILED',
    })
  })

  it('reconciles a dispatching task to succeeded during the scheduled sweep when the output object exists', async () => {
    const taskId = 'task_reconcile_dispatching_success_abcdefghi'
    const outputObjectKey = `parseotter/${taskId}/output/result.zip`

    await insertDispatchTask({
      taskId,
      status: 'dispatching',
      dispatchStatus: 'dispatching',
      dispatchStartedAt: '2026-04-24T23:05:00.000Z',
    })
    await env.R2_BUCKET.put(outputObjectKey, 'zip-output', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'succeeded',
      visible_status: 'Conversion complete',
      error_code: null,
      output_object_key: outputObjectKey,
      output_content_type: 'application/zip',
      output_size_bytes: 10,
      last_callback_idempotency_key: null,
    })
  })

  it('marks a stale processing task failed during the scheduled sweep after the processing timeout', async () => {
    const taskId = 'task_reconcile_timeout_abcdefghijklmnopqrstuvwxyz'
    Object.assign(env, {
      PROCESSING_TIMEOUT_SECONDS: '1800',
    })

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, upload_status, input_object_key, input_size_bytes,
        input_content_type, input_part_count, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
        dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        'processing',
        'Converting',
        6,
        1,
        '2026-04-24T20:00:00.000Z',
        '2026-04-24T20:10:00.000Z',
        '2026-04-27T20:00:00.000Z',
        'scheduled-timeout.pdf',
        'application/pdf',
        123,
        'completed',
        `parseotter/${taskId}/input/original.pdf`,
        123,
        'application/pdf',
        1,
        'dispatched',
        1,
        `${taskId}:dispatch:1`,
        '2026-04-24T20:05:00.000Z',
        '2026-04-24T20:10:00.000Z',
        null
      )
      .run()

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'failed',
      visible_status: 'Conversion failed',
      error_code: 'PROCESSING_TIMEOUT',
    })
  })

  it('marks a stale dispatching task failed during the scheduled sweep after the processing timeout', async () => {
    const taskId = 'task_reconcile_dispatching_timeout_abcdefghi'
    Object.assign(env, {
      PROCESSING_TIMEOUT_SECONDS: '1800',
    })

    await insertDispatchTask({
      taskId,
      status: 'dispatching',
      dispatchStatus: 'dispatching',
      dispatchStartedAt: '2026-04-24T20:05:00.000Z',
    })

    const controller = createScheduledController({
      cron: '*/30 * * * *',
      scheduledTime: scheduledAt,
    })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'failed',
      visible_status: 'Conversion failed',
      error_code: 'PROCESSING_TIMEOUT',
    })
  })

  it('does not let R2 delete failures block the D1 expired marker', async () => {
    const taskId = 'task_cleanupabcdefghijklmnopqrstuvwxyz34'
    await insertExpiredTask({
      taskId,
      inputObjectKey: `parseotter/${taskId}/input/original.pdf`,
    })

    const result = await cleanupExpiredTasks({
      db: env.DB,
      bucket: {
        delete: async () => {
          throw new Error('R2 unavailable')
        },
      },
      now: scheduledAt,
      limit: 10,
    })

    expect(result).toMatchObject({
      scanned: 1,
      markedExpired: 1,
      objectDeleteFailures: 1,
    })
    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'expired',
      visible_status: 'Expired',
      expired_at: scheduledAt.toISOString(),
      error_code: 'TASK_EXPIRED',
    })
  })

  it('skips fully cleaned expired records so later expired objects are not starved by the batch limit', async () => {
    const targetTaskId = 'task_cleanup_starvation_target_abcdefghi'
    const inputObjectKey = `parseotter/${targetTaskId}/input/original.pdf`

    await insertExpiredTask({
      taskId: 'task_cleanup_cleaned_old_record_00000001',
      status: 'expired',
      visibleStatus: 'Expired',
      inputObjectKey: null,
      outputObjectKey: null,
    })
    await insertExpiredTask({
      taskId: 'task_cleanup_cleaned_old_record_00000002',
      status: 'expired',
      visibleStatus: 'Expired',
      inputObjectKey: null,
      outputObjectKey: null,
    })
    await insertExpiredTask({
      taskId: targetTaskId,
      status: 'expired',
      visibleStatus: 'Expired',
      inputObjectKey,
      outputObjectKey: null,
    })

    const deletedKeys: string[] = []
    const result = await cleanupExpiredTasks({
      db: env.DB,
      bucket: {
        delete: async (key) => {
          if (Array.isArray(key)) {
            throw new Error('expected single object key')
          }
          deletedKeys.push(key)
        },
      },
      now: scheduledAt,
      limit: 2,
    })

    expect(result).toMatchObject({
      scanned: 1,
      objectsDeleted: 1,
      objectDeleteFailures: 0,
    })
    expect(deletedKeys).toEqual([inputObjectKey])
    await expect(readTaskStatus(targetTaskId)).resolves.toMatchObject({
      status: 'expired',
      input_object_key: null,
      output_object_key: null,
    })
  })

  it('clears only successfully deleted object keys and keeps failed keys for retry', async () => {
    const taskId = 'task_cleanup_partial_delete_retry_abcdef'
    const inputObjectKey = `parseotter/${taskId}/input/original.pdf`
    const outputObjectKey = `parseotter/${taskId}/output/result.zip`

    await insertExpiredTask({
      taskId,
      inputObjectKey,
      outputObjectKey,
    })

    const result = await cleanupExpiredTasks({
      db: env.DB,
      bucket: {
        delete: async (key) => {
          if (key === outputObjectKey) {
            throw new Error('R2 unavailable')
          }
        },
      },
      now: scheduledAt,
      limit: 10,
    })

    expect(result).toMatchObject({
      scanned: 1,
      markedExpired: 1,
      objectsDeleted: 1,
      objectDeleteFailures: 1,
    })
    await expect(readTaskStatus(taskId)).resolves.toMatchObject({
      status: 'expired',
      input_object_key: null,
      output_object_key: outputObjectKey,
    })
  })

  it('does not rescan expired records after all object keys were cleared', async () => {
    const taskId = 'task_cleanup_repeat_scan_skip_abcdefghi'
    const inputObjectKey = `parseotter/${taskId}/input/original.pdf`

    await insertExpiredTask({
      taskId,
      status: 'expired',
      visibleStatus: 'Expired',
      inputObjectKey,
    })

    const result = await cleanupExpiredTasks({
      db: env.DB,
      bucket: {
        delete: async () => {},
      },
      now: scheduledAt,
      limit: 10,
    })
    const secondResult = await cleanupExpiredTasks({
      db: env.DB,
      bucket: {
        delete: async () => {
          throw new Error('should not delete again')
        },
      },
      now: scheduledAt,
      limit: 10,
    })

    expect(result).toMatchObject({
      scanned: 1,
      objectsDeleted: 1,
    })
    expect(secondResult).toMatchObject({
      scanned: 0,
      objectsDeleted: 0,
      objectDeleteFailures: 0,
    })
  })
})
