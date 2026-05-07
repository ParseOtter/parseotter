import { sanitizeGaClientId } from '../analytics/ga4'
import { createSingleValidationIssueError } from '../http/validation'
import { validateTaskFileMetadata } from './upload-validation'

export type CreateTaskRequest = {
  fileName: string
  fileType: string
  fileSizeBytes: number
  turnstileToken: string | null
  gaClientId: string | null
}

function readStringField(payload: Record<string, unknown>, fieldName: string, maxLength: number): string {
  const value = payload[fieldName]

  if (typeof value !== 'string') {
    throw createSingleValidationIssueError({
      field: fieldName,
      code: 'required',
      message: `${fieldName} is required`,
    })
  }

  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw createSingleValidationIssueError({
      field: fieldName,
      code: 'invalid_length',
      message: `${fieldName} is invalid`,
    })
  }

  return trimmed
}

function readPositiveIntegerField(payload: Record<string, unknown>, fieldName: string): number {
  const value = payload[fieldName]

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw createSingleValidationIssueError({
      field: fieldName,
      code: 'invalid_integer',
      message: `${fieldName} must be a positive integer`,
    })
  }

  return value
}

export function parseCreateTaskRequest(
  payload: Record<string, unknown>,
  env?: Partial<CloudflareBindings>
): CreateTaskRequest {
  const turnstileToken = payload.turnstileToken
  const request = {
    fileName: readStringField(payload, 'fileName', 255),
    fileType: readStringField(payload, 'fileType', 128),
    fileSizeBytes: readPositiveIntegerField(payload, 'fileSizeBytes'),
    turnstileToken: typeof turnstileToken === 'string' && turnstileToken.trim().length > 0 ? turnstileToken.trim() : null,
    gaClientId: sanitizeGaClientId(payload.gaClientId),
  }

  validateTaskFileMetadata(request.fileType, request.fileSizeBytes, env)

  return request
}
