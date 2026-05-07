import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create-app'
import { resetTaskDatabase } from '../support/task-db'

type ApiEnvelope<T> = {
  success: boolean
  data: T
  error: null | {
    code: string
    message: string
  }
}

type TaskPayload = {
  taskId: string
}

const CLIENT_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'abuse-test-browser',
  'cf-connecting-ip': '203.0.113.55',
  'x-request-id': 'request-abuse-test',
}

function createAbuseTestEnv(overrides: Record<string, unknown> = {}): typeof env {
  return {
    ...env,
    ABUSE_LIMITING_ENABLED: 'true',
    CONVERT_PUBLIC_ENABLED: 'true',
    TURNSTILE_ENABLED: 'false',
    TURNSTILE_SECRET_KEY: '',
    CLIENT_ACTIVE_TASK_LIMIT: '1',
    CLIENT_CREATE_TASKS_PER_HOUR: '10',
    CLIENT_DAILY_UPLOAD_BYTES_LIMIT: String(300 * 1024 * 1024),
    GLOBAL_PENDING_DISPATCH_LIMIT: '20',
    GLOBAL_DAILY_DISPATCH_LIMIT: '100',
    ...overrides,
  } as unknown as typeof env
}

function createTaskRequest(fileName: string): RequestInit {
  return {
    method: 'POST',
    headers: CLIENT_HEADERS,
    body: JSON.stringify({
      fileName,
      fileType: 'application/pdf',
      fileSizeBytes: 12345,
    }),
  }
}

describe('simple convert abuse limiting', () => {
  beforeEach(async () => {
    await resetTaskDatabase(env.DB)
  })

  it('stores server-derived client hashes and daily usage when creating a task', async () => {
    const app = createApp()
    const testEnv = createAbuseTestEnv()

    const response = await app.request('https://backend.test/api/tasks', createTaskRequest('sample.pdf'), testEnv)
    const payload = (await response.json()) as ApiEnvelope<TaskPayload>

    expect(response.status).toBe(201)

    const row = await env.DB.prepare(
      `SELECT client_hash, client_user_agent, client_ip_hash
       FROM parseotter_tasks
       WHERE task_id = ?`
    )
      .bind(payload.data.taskId)
      .first<{
        client_hash: string
        client_user_agent: string
        client_ip_hash: string
      }>()

    expect(row).toMatchObject({
      client_user_agent: 'abuse-test-browser',
    })
    expect(row?.client_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row?.client_ip_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row?.client_hash).not.toBe('203.0.113.55')
    expect(row?.client_ip_hash).not.toBe('203.0.113.55')

    const usage = await env.DB.prepare(
      `SELECT created_count
       FROM parseotter_client_usage_daily
       WHERE client_hash = ?`
    )
      .bind(row?.client_hash)
      .first<{ created_count: number }>()

    expect(usage).toEqual({ created_count: 1 })
  })

  it('rejects a second active task from the same anonymous client before upload starts', async () => {
    const app = createApp()
    const testEnv = createAbuseTestEnv()

    const firstResponse = await app.request('https://backend.test/api/tasks', createTaskRequest('first.pdf'), testEnv)
    expect(firstResponse.status).toBe(201)

    const secondResponse = await app.request('https://backend.test/api/tasks', createTaskRequest('second.pdf'), testEnv)

    expect(secondResponse.status).toBe(429)
    await expect(secondResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'CLIENT_ACTIVE_TASK_LIMIT_EXCEEDED',
        message: 'You already have a conversion in progress.',
      },
    })

    const event = await env.DB.prepare(
      `SELECT route, event_type, reason_code, status
       FROM parseotter_abuse_events
       WHERE reason_code = ?`
    )
      .bind('CLIENT_ACTIVE_TASK_LIMIT_EXCEEDED')
      .first<{
        route: string
        event_type: string
        reason_code: string
        status: number
      }>()

    expect(event).toEqual({
      route: 'create_task',
      event_type: 'quota_rejected',
      reason_code: 'CLIENT_ACTIVE_TASK_LIMIT_EXCEEDED',
      status: 429,
    })
  })

  it('rejects missing Turnstile tokens when Turnstile is enabled', async () => {
    const testEnv = createAbuseTestEnv({
      TURNSTILE_ENABLED: 'true',
      TURNSTILE_SECRET_KEY: 'turnstile-secret',
    })
    const app = createApp()

    const response = await app.request('https://backend.test/api/tasks', createTaskRequest('sample.pdf'), testEnv)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'TURNSTILE_FAILED',
      },
    })

    const usage = await env.DB.prepare('SELECT turnstile_failed_count FROM parseotter_global_usage_daily').first<{
      turnstile_failed_count: number
    }>()

    expect(usage).toEqual({ turnstile_failed_count: 1 })
  })

  it('returns the common 429 envelope when a Workers rate-limit binding rejects a request', async () => {
    const testEnv = createAbuseTestEnv({
      CREATE_TASK_RATE_LIMITER: {
        limit: async () => ({ success: false }),
      },
    })
    const app = createApp()

    const response = await app.request('https://backend.test/api/tasks', createTaskRequest('sample.pdf'), testEnv)

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
      },
    })
  })
})
