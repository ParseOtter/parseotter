import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create-app'

type HealthPayload = {
  data: {
    timestamp: unknown
  }
  [key: string]: unknown
}

type ErrorPayload = {
  error: {
    timestamp: unknown
    details?: {
      issues?: Array<{
        field: string
        code: string
        message: string
      }>
    }
  }
  [key: string]: unknown
}

describe('ParseOtter API base routes', () => {
  it('returns a health payload with the common success envelope', async () => {
    const app = createApp()

    const response = await app.request('https://backend.test/health', {
      headers: {
        origin: 'http://localhost:5173',
        'x-request-id': 'request-health',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-request-id')).toBe('request-health')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const payload = (await response.json()) as HealthPayload

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        status: 'ok',
        service: 'parseotter-api',
        runtime: 'cloudflare-worker',
      },
    })
    expect(payload.data.timestamp).toEqual(expect.any(String))
  })

  it('returns the common error envelope for missing routes without leaking internals', async () => {
    const app = createApp()

    const response = await app.request('https://backend.test/missing', {
      headers: {
        origin: 'http://localhost:5173',
        'x-request-id': 'request-missing',
      },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('x-request-id')).toBe('request-missing')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const payload = (await response.json()) as ErrorPayload

    expect(payload).toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist',
        requestId: 'request-missing',
      },
    })
    expect(payload.error.timestamp).toEqual(expect.any(String))
  })

  it('returns structured validation details for malformed JSON request bodies', async () => {
    const app = createApp()

    const response = await app.request('https://backend.test/api/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'request-invalid-json',
      },
      body: '{',
    })

    expect(response.status).toBe(400)

    const payload = (await response.json()) as ErrorPayload

    expect(payload).toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        requestId: 'request-invalid-json',
        details: {
          issues: [
            {
              field: 'body',
              code: 'invalid_json',
              message: 'Request body must be valid JSON',
            },
          ],
        },
      },
    })
    expect(payload.error.timestamp).toEqual(expect.any(String))
  })
})
