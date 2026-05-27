import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create-app'

describe('CORS allowlist', () => {
  it('allows the deployed frontend Worker origin for browser API requests', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://your-frontend.workers.dev',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      },
      {
        CORS_ORIGINS:
          'https://your-frontend.workers.dev,http://localhost:5173,http://127.0.0.1:5173',
      }
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://your-frontend.workers.dev'
    )
  })

  it('responds to allowed preflight requests with the public API headers', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://convert.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-request-id',
          'x-request-id': 'request-preflight',
        },
      },
      {
        CORS_ORIGINS: 'https://convert.example.com,http://localhost:5173',
      }
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://convert.example.com')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'authorization,content-type,x-api-key,x-idempotency-key,x-modal-signature,x-modal-timestamp,x-request-id'
    )
    expect(response.headers.get('access-control-max-age')).toBe('600')
    expect(response.headers.get('x-request-id')).toBe('request-preflight')
    expect(await response.text()).toBe('')
  })

  it('omits allow-origin headers for disallowed origins', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/health',
      {
        headers: {
          origin: 'https://not-allowed.example.com',
          'x-request-id': 'request-denied',
        },
      },
      {
        CORS_ORIGINS: 'https://convert.example.com',
      }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('x-request-id')).toBe('request-denied')
  })
})
