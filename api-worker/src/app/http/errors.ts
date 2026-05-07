export type ErrorDetails = Record<string, unknown>

export type AppHttpErrorInput = {
  status: number
  code: string
  message: string
  details?: ErrorDetails
}

export type ErrorEnvelope = {
  success: false
  data: null
  error: {
    code: string
    message: string
    timestamp: string
    requestId?: string
    details?: ErrorDetails
  }
}

function isErrorDetails(value: unknown): value is ErrorDetails {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readErrorProperty(error: unknown, key: 'status' | 'code' | 'message' | 'details'): unknown {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  return (error as Record<string, unknown>)[key]
}

export class AppHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: ErrorDetails

  constructor(input: AppHttpErrorInput) {
    super(input.message)
    this.name = 'AppHttpError'
    this.status = input.status
    this.code = input.code
    this.details = input.details
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function mapStatusToErrorCode(status: number): string {
  if (status === 401) {
    return 'UNAUTHORIZED'
  }

  if (status === 403) {
    return 'FORBIDDEN'
  }

  if (status === 404) {
    return 'NOT_FOUND'
  }

  if (status === 409) {
    return 'CONFLICT'
  }

  if (status >= 400 && status < 500) {
    return 'INVALID_REQUEST'
  }

  return 'INTERNAL_ERROR'
}

export function normalizeAppError(error: unknown): AppHttpError {
  if (error instanceof AppHttpError) {
    return error
  }

  const status = readErrorProperty(error, 'status')
  const code = readErrorProperty(error, 'code')
  const message = readErrorProperty(error, 'message')
  const details = readErrorProperty(error, 'details')

  if (typeof status === 'number' && typeof message === 'string' && message.trim().length > 0) {
    const safeMessage = status >= 500 ? 'An internal server error occurred' : message

    return new AppHttpError({
      status,
      code: typeof code === 'string' && code.trim().length > 0 ? code : mapStatusToErrorCode(status),
      message: safeMessage,
      details: isErrorDetails(details) ? details : undefined,
    })
  }

  return new AppHttpError({
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'An internal server error occurred',
  })
}

export function createErrorBody(error: AppHttpError, requestId?: string | null): ErrorEnvelope {
  const trimmedRequestId = requestId?.trim()

  return {
    success: false,
    data: null,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(trimmedRequestId ? { requestId: trimmedRequestId } : {}),
      timestamp: new Date().toISOString(),
    },
  }
}
