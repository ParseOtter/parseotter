import { AppHttpError, type ErrorDetails } from './errors'

export type ValidationIssue = {
  field: string
  code: string
  message: string
}

export function createRequestValidationError(issues: readonly ValidationIssue[]): AppHttpError {
  return new AppHttpError({
    status: 400,
    code: 'INVALID_REQUEST',
    message: 'Request validation failed',
    details: {
      issues: issues.map((issue) => ({ ...issue })),
    } satisfies ErrorDetails,
  })
}

export function createSingleValidationIssueError(issue: ValidationIssue): AppHttpError {
  return createRequestValidationError([issue])
}
