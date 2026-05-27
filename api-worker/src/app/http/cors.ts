import type { Hono } from 'hono'

import type { AppEnv } from '../env'
import { readCorsOrigins } from '../runtime-config'

const ALLOW_HEADERS = 'authorization,content-type,x-api-key,x-idempotency-key,x-modal-signature,x-modal-timestamp,x-request-id'
const ALLOW_METHODS = 'GET,POST,OPTIONS'
const MAX_AGE_SECONDS = '600'

function resolveCorsOrigin(origin: string | null, allowedOrigins: string[]): string | null {
  const trimmedOrigin = origin?.trim()

  if (!trimmedOrigin) {
    return null
  }

  if (allowedOrigins.includes('*')) {
    return trimmedOrigin
  }

  return allowedOrigins.includes(trimmedOrigin) ? trimmedOrigin : null
}

function appendCorsHeaders(headers: Headers, origin: string | null): void {
  if (!origin) {
    return
  }

  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', ALLOW_METHODS)
  headers.set('access-control-allow-headers', ALLOW_HEADERS)
  headers.set('access-control-max-age', MAX_AGE_SECONDS)
  headers.set('vary', 'Origin')
}

export function registerCorsMiddleware(app: Hono<AppEnv>): void {
  app.use('*', async (c, next) => {
    const allowedOrigin = resolveCorsOrigin(c.req.header('origin') ?? null, readCorsOrigins(c.env))

    if (c.req.method === 'OPTIONS') {
      const headers = new Headers()
      appendCorsHeaders(headers, allowedOrigin)
      headers.set('x-request-id', c.get('requestId'))

      return new Response(null, {
        status: 204,
        headers,
      })
    }

    await next()
    appendCorsHeaders(c.res.headers, allowedOrigin)
  })
}
