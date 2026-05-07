import { createErrorBody, type AppHttpError } from './errors'
import { REQUEST_ID_HEADER } from './request-id'

type JsonResponseInit = ResponseInit & {
  requestId?: string | null
}

export type SuccessEnvelope<T> = {
  success: true
  data: T
  error: null
}

function createJsonHeaders(headers?: HeadersInit, requestId?: string | null): Headers {
  const responseHeaders = new Headers(headers)

  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'application/json')
  }

  const trimmedRequestId = requestId?.trim()
  if (trimmedRequestId) {
    responseHeaders.set(REQUEST_ID_HEADER, trimmedRequestId)
  }

  return responseHeaders
}

export function jsonResponse(body: unknown, init?: JsonResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: createJsonHeaders(init?.headers, init?.requestId),
  })
}

export function jsonSuccess<T>(data: T, init?: JsonResponseInit): Response {
  return jsonResponse(
    {
      success: true,
      data,
      error: null,
    } satisfies SuccessEnvelope<T>,
    init
  )
}

export function jsonError(error: AppHttpError, requestId?: string | null): Response {
  return jsonResponse(createErrorBody(error, requestId), {
    status: error.status,
    requestId,
  })
}
