import { isJsonObject } from '../../lib/json'
import { createSingleValidationIssueError } from './validation'

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let payload: unknown

  try {
    payload = await request.json()
  } catch {
    throw createSingleValidationIssueError({
      field: 'body',
      code: 'invalid_json',
      message: 'Request body must be valid JSON',
    })
  }

  if (!isJsonObject(payload)) {
    throw createSingleValidationIssueError({
      field: 'body',
      code: 'invalid_type',
      message: 'Request body must be a JSON object',
    })
  }

  return payload
}
