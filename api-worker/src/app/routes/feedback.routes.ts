import type { Hono } from 'hono'

import {
  countRecentFeedbackByClientHash,
  createFeedbackClientHash,
  createFeedbackReceipt,
  hasReachedFeedbackRateLimit,
  insertFeedbackRecord,
  readFeedbackUserAgent,
} from '../feedback/feedback-record'
import { parseCreateFeedbackRequest } from '../feedback/feedback-validation'
import type { AppEnv } from '../env'
import { AppHttpError } from '../http/errors'
import { readJsonObject } from '../http/json-body'
import { jsonSuccess } from '../http/responses'

function hasFilledHoneypot(payload: Record<string, unknown>): boolean {
  return typeof payload.companyName === 'string' && payload.companyName.trim().length > 0
}

export function registerFeedbackRoutes(app: Hono<AppEnv>): void {
  app.post('/api/feedback', async (c) => {
    const payload = await readJsonObject(c.req.raw)
    const now = new Date()

    if (hasFilledHoneypot(payload)) {
      return jsonSuccess(createFeedbackReceipt(now), {
        status: 201,
        requestId: c.get('requestId'),
      })
    }

    const feedback = parseCreateFeedbackRequest(payload)
    const clientHash = await createFeedbackClientHash(c.req.raw)
    const recentFeedbackCount = await countRecentFeedbackByClientHash(c.env.DB, {
      clientHash,
      now,
    })

    if (hasReachedFeedbackRateLimit(recentFeedbackCount)) {
      throw new AppHttpError({
        status: 429,
        code: 'FEEDBACK_RATE_LIMITED',
        message: 'Too many feedback submissions. Please try again later.',
      })
    }

    const receipt = await insertFeedbackRecord(c.env.DB, {
      ...feedback,
      clientHash,
      userAgent: readFeedbackUserAgent(c.req.raw),
      requestId: c.get('requestId'),
      now,
    })

    return jsonSuccess(receipt, {
      status: 201,
      requestId: c.get('requestId'),
    })
  })
}
