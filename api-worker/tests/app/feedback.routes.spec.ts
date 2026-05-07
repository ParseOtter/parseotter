import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create-app'
import { FEEDBACK_SCHEMA_STATEMENTS } from '../../src/app/feedback/feedback-schema'

type ApiEnvelope<T> = {
  success: boolean
  data: T
  error: null | {
    code: string
    message: string
    details?: {
      issues?: Array<{
        field: string
        code: string
        message: string
      }>
    }
  }
}

type FeedbackResponse = {
  feedbackId: string
  receivedAt: string
}

type FeedbackRow = {
  feedback_id: string
  category: string
  rating: number | null
  message: string
  contact: string | null
  page_url: string | null
  user_agent: string | null
  client_hash: string
  request_id: string | null
  source: string
  status: string
}

async function resetFeedbackDatabase(db: D1Database): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS parseotter_feedback;')
  for (const statement of FEEDBACK_SCHEMA_STATEMENTS) {
    await db.exec(statement)
  }
}

function createFeedbackRequest(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      'user-agent': 'feedback-test-browser',
      'cf-connecting-ip': '203.0.113.10',
      'x-request-id': 'request-feedback',
    },
    body: JSON.stringify(body),
  }
}

describe('feedback routes', () => {
  beforeEach(async () => {
    await resetFeedbackDatabase(env.DB)
  })

  it('accepts product feedback and stores a privacy-conscious D1 record', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/feedback',
      createFeedbackRequest({
        category: 'conversion_quality',
        rating: 4,
        message: 'The Markdown headings are useful, but tables need a little cleanup.',
        contact: 'ray@example.com',
        pageUrl: 'https://your-frontend.workers.dev/',
      }),
      env
    )

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(201)
    expect(response.headers.get('x-request-id')).toBe('request-feedback')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const payload = (await response.json()) as ApiEnvelope<FeedbackResponse>
    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        feedbackId: expect.stringMatching(/^feedback_[A-Za-z0-9_-]{24,}$/),
        receivedAt: expect.any(String),
      },
    })

    const row = await env.DB.prepare('SELECT * FROM parseotter_feedback WHERE feedback_id = ?')
      .bind(payload.data.feedbackId)
      .first<FeedbackRow>()

    expect(row).toMatchObject({
      feedback_id: payload.data.feedbackId,
      category: 'conversion_quality',
      rating: 4,
      message: 'The Markdown headings are useful, but tables need a little cleanup.',
      contact: 'ray@example.com',
      page_url: 'https://your-frontend.workers.dev/',
      user_agent: 'feedback-test-browser',
      request_id: 'request-feedback',
      source: 'parseotter_frontend',
      status: 'open',
    })
    expect(row?.client_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row?.client_hash).not.toBe('203.0.113.10')
  })

  it('returns structured validation errors for unusable feedback', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/feedback',
      createFeedbackRequest({
        category: 'conversion_quality',
        message: ' ',
      }),
      env
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        details: {
          issues: [
            {
              field: 'message',
              code: 'too_short',
            },
          ],
        },
      },
    })
  })

  it('rate limits repeated feedback from the same browser fingerprint', async () => {
    const app = createApp()

    for (let index = 0; index < 5; index += 1) {
      const response = await app.request(
        'https://backend.test/api/feedback',
        createFeedbackRequest({
          category: 'performance',
          message: `Processing felt slow on attempt ${index + 1}.`,
        }),
        env
      )
      expect(response.status).toBe(201)
    }

    const response = await app.request(
      'https://backend.test/api/feedback',
      createFeedbackRequest({
        category: 'performance',
        message: 'Processing still feels slow.',
      }),
      env
    )

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'FEEDBACK_RATE_LIMITED',
      },
    })
  })

  it('quietly accepts honeypot submissions without storing them', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/feedback',
      createFeedbackRequest({
        category: 'not_supported',
        message: '',
        companyName: 'bot-filled-field',
      }),
      env
    )

    expect(response.status).toBe(201)
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM parseotter_feedback').first<{ count: number }>()

    expect(count).toEqual({ count: 0 })
  })
})
