import { sha256Hex } from '../../lib/crypto'
import type { FeedbackCategory } from './feedback-validation'

const FEEDBACK_RATE_LIMIT_PER_HOUR = 5
const ONE_HOUR_MS = 60 * 60 * 1000
const MAX_USER_AGENT_LENGTH = 500

export type FeedbackReceipt = {
  feedbackId: string
  receivedAt: string
}

export type InsertFeedbackInput = {
  category: FeedbackCategory
  rating: number | null
  message: string
  contact: string | null
  pageUrl: string | null
  userAgent: string | null
  clientHash: string
  requestId: string | null
  now?: Date
}

function createFeedbackId(): string {
  return `feedback_${crypto.randomUUID().replace(/-/g, '')}`
}

function truncateOptional(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function readClientAddress(request: Request): string {
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim()
  if (connectingIp) {
    return connectingIp
  }

  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwardedFor && forwardedFor.length > 0 ? forwardedFor : 'unknown'
}

export function readFeedbackUserAgent(request: Request): string | null {
  return truncateOptional(request.headers.get('user-agent')?.trim() ?? null, MAX_USER_AGENT_LENGTH)
}

export async function createFeedbackClientHash(request: Request): Promise<string> {
  const userAgent = readFeedbackUserAgent(request) ?? 'unknown'
  const material = `${readClientAddress(request)}\n${userAgent}`
  return sha256Hex(material)
}

export async function countRecentFeedbackByClientHash(
  db: D1Database,
  input: {
    clientHash: string
    now?: Date
  }
): Promise<number> {
  const since = new Date((input.now ?? new Date()).getTime() - ONE_HOUR_MS).toISOString()
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM parseotter_feedback
       WHERE client_hash = ? AND created_at >= ?`
    )
    .bind(input.clientHash, since)
    .first<{ count: number }>()

  return row?.count ?? 0
}

export function hasReachedFeedbackRateLimit(count: number): boolean {
  return count >= FEEDBACK_RATE_LIMIT_PER_HOUR
}

export function createFeedbackReceipt(now?: Date): FeedbackReceipt {
  return {
    feedbackId: createFeedbackId(),
    receivedAt: (now ?? new Date()).toISOString(),
  }
}

export async function insertFeedbackRecord(db: D1Database, input: InsertFeedbackInput): Promise<FeedbackReceipt> {
  const receipt = createFeedbackReceipt(input.now)

  await db
    .prepare(
      `INSERT INTO parseotter_feedback (
        feedback_id, created_at, category, rating, message, contact, page_url, user_agent,
        client_hash, request_id, source, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      receipt.feedbackId,
      receipt.receivedAt,
      input.category,
      input.rating,
      input.message,
      input.contact,
      input.pageUrl,
      truncateOptional(input.userAgent, MAX_USER_AGENT_LENGTH),
      input.clientHash,
      input.requestId,
      'parseotter_frontend',
      'open'
    )
    .run()

  return receipt
}
