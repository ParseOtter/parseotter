export const REQUEST_ID_HEADER = 'x-request-id'

function normalizeRequestId(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= 128 ? trimmed : null
}

export function resolveRequestId(request: Request): string {
  return normalizeRequestId(request.headers.get(REQUEST_ID_HEADER)) ?? crypto.randomUUID()
}
