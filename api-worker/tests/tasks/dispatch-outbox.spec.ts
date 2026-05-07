import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimDispatchPendingTask,
  listDispatchPendingSnapshots,
  markTaskDispatchPending,
} from '../../src/app/tasks/dispatch-outbox'
import { resetTaskDatabase } from '../support/task-db'

const now = new Date('2026-04-25T00:00:00.000Z')

async function insertTask(input: {
  taskId: string
  status: string
  visibleStatus: string
  expiresAt?: string
  dispatchStatus?: string | null
  dispatchAttempt?: number
  dispatchIdempotencyKey?: string | null
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO parseotter_tasks (
      task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
      file_name, file_type, file_size_bytes, dispatch_status, dispatch_attempt, dispatch_idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.taskId,
      input.status,
      input.visibleStatus,
      1,
      0,
      '2026-04-25T00:00:00.000Z',
      '2026-04-25T00:00:00.000Z',
      input.expiresAt ?? '2026-04-27T00:00:00.000Z',
      'dispatch.pdf',
      'application/pdf',
      123,
      input.dispatchStatus ?? null,
      input.dispatchAttempt ?? 0,
      input.dispatchIdempotencyKey ?? null
    )
    .run()
}

describe('dispatch outbox', () => {
  beforeEach(async () => {
    await resetTaskDatabase(env.DB)
  })

  it('creates a deterministic dispatch pending outbox record from an uploaded task', async () => {
    const taskId = 'task_dispatchabcdefghijklmnopqrstuvwxyz'
    await insertTask({ taskId, status: 'upload_completed', visibleStatus: 'Upload complete' })

    const result = await markTaskDispatchPending(env.DB, taskId, now)

    expect(result).toMatchObject({
      created: true,
      snapshot: {
        taskId,
        status: 'dispatch_pending',
        visibleStatus: 'Waiting for conversion',
        attempt: 1,
        dispatchStatus: 'pending',
        dispatchAttempt: 1,
        dispatchIdempotencyKey: `${taskId}:dispatch:1`,
      },
    })

    await expect(listDispatchPendingSnapshots(env.DB, now)).resolves.toMatchObject([
      {
        taskId,
        status: 'dispatch_pending',
        dispatchStatus: 'pending',
        dispatchIdempotencyKey: `${taskId}:dispatch:1`,
      },
    ])
  })

  it('claims a pending dispatch once and keeps duplicate claim attempts idempotent', async () => {
    const taskId = 'task_dispatchabcdefghijklmnopqrstuvwx12'
    await insertTask({ taskId, status: 'upload_completed', visibleStatus: 'Upload complete' })
    const pending = await markTaskDispatchPending(env.DB, taskId, now)

    const firstClaim = await claimDispatchPendingTask(env.DB, taskId, now)
    const secondClaim = await claimDispatchPendingTask(env.DB, taskId, now)

    expect(firstClaim).toMatchObject({
      claimed: true,
      snapshot: {
        taskId,
        status: 'dispatching',
        visibleStatus: 'Converting',
        attempt: 1,
        dispatchStatus: 'dispatching',
        dispatchAttempt: 1,
        dispatchIdempotencyKey: pending.snapshot?.dispatchIdempotencyKey,
        dispatchStartedAt: now.toISOString(),
      },
    })
    expect(secondClaim).toMatchObject({
      claimed: false,
      snapshot: {
        taskId,
        status: 'dispatching',
        dispatchAttempt: 1,
        dispatchIdempotencyKey: pending.snapshot?.dispatchIdempotencyKey,
      },
    })
  })

  it('does not list expired dispatch pending tasks for compensation', async () => {
    const taskId = 'task_dispatchabcdefghijklmnopqrstuvwx34'
    await insertTask({
      taskId,
      status: 'dispatch_pending',
      visibleStatus: 'Waiting for conversion',
      expiresAt: '2026-04-24T00:00:00.000Z',
      dispatchStatus: 'pending',
      dispatchAttempt: 1,
      dispatchIdempotencyKey: `${taskId}:dispatch:1`,
    })

    await expect(listDispatchPendingSnapshots(env.DB, now)).resolves.toEqual([])
    await expect(claimDispatchPendingTask(env.DB, taskId, now)).resolves.toMatchObject({
      claimed: false,
      snapshot: {
        status: 'expired',
        visibleStatus: 'Expired',
      },
    })
  })
})
