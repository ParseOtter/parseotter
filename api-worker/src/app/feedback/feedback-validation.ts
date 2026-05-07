import { createRequestValidationError, type ValidationIssue } from '../http/validation'

export const FEEDBACK_CATEGORIES = ['bug', 'conversion_quality', 'performance', 'feature_request', 'other'] as const

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

export type CreateFeedbackInput = {
  category: FeedbackCategory
  rating: number | null
  message: string
  contact: string | null
  pageUrl: string | null
  companyName: string
}

const MESSAGE_MIN_LENGTH = 3
const MESSAGE_MAX_LENGTH = 2000
const CONTACT_MAX_LENGTH = 200
const PAGE_URL_MAX_LENGTH = 1000

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && FEEDBACK_CATEGORIES.includes(value as FeedbackCategory)
}

function readTrimmedOptionalString(
  payload: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: ValidationIssue[]
): string | null {
  const value = payload[field]

  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    issues.push({
      field,
      code: 'invalid_type',
      message: `${field} must be a string`,
    })
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  if (trimmed.length > maxLength) {
    issues.push({
      field,
      code: 'too_long',
      message: `${field} is too long`,
    })
    return null
  }

  return trimmed
}

function readRating(value: unknown, issues: ValidationIssue[]): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    issues.push({
      field: 'rating',
      code: 'out_of_range',
      message: 'rating must be an integer from 1 to 5',
    })
    return null
  }

  return value
}

function readPageUrl(payload: Record<string, unknown>, issues: ValidationIssue[]): string | null {
  const pageUrl = readTrimmedOptionalString(payload, 'pageUrl', PAGE_URL_MAX_LENGTH, issues)
  if (!pageUrl) {
    return null
  }

  try {
    const parsed = new URL(pageUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return pageUrl
    }
  } catch {
    // Handled below.
  }

  issues.push({
    field: 'pageUrl',
    code: 'invalid_url',
    message: 'pageUrl must be an http or https URL',
  })
  return null
}

function readCompanyName(payload: Record<string, unknown>): string {
  const value = payload.companyName
  return typeof value === 'string' ? value.trim() : ''
}

export function parseCreateFeedbackRequest(payload: Record<string, unknown>): CreateFeedbackInput {
  const issues: ValidationIssue[] = []

  if (!isFeedbackCategory(payload.category)) {
    issues.push({
      field: 'category',
      code: 'invalid_value',
      message: 'category must be one of the supported feedback categories',
    })
  }

  const rawMessage = payload.message
  let message = ''

  if (typeof rawMessage !== 'string') {
    issues.push({
      field: 'message',
      code: 'invalid_type',
      message: 'message must be a string',
    })
  } else {
    message = rawMessage.trim()
    if (message.length < MESSAGE_MIN_LENGTH) {
      issues.push({
        field: 'message',
        code: 'too_short',
        message: 'message must be at least 3 characters',
      })
    } else if (message.length > MESSAGE_MAX_LENGTH) {
      issues.push({
        field: 'message',
        code: 'too_long',
        message: 'message is too long',
      })
    }
  }

  const rating = readRating(payload.rating, issues)
  const contact = readTrimmedOptionalString(payload, 'contact', CONTACT_MAX_LENGTH, issues)
  const pageUrl = readPageUrl(payload, issues)

  if (issues.length > 0) {
    throw createRequestValidationError(issues)
  }

  return {
    category: payload.category as FeedbackCategory,
    rating,
    message,
    contact,
    pageUrl,
    companyName: readCompanyName(payload),
  }
}
