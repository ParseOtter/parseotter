import type { MiddlewareHandler } from 'hono'

import { readApiKeyAuthEnabled } from '../abuse/abuse-config'
import { verifyApiKey } from '../security/api-key'
import type { AppEnv } from '../env'

const BEARER_PREFIX = 'Bearer '
const API_KEY_HEADER = 'x-api-key'

function extractRawKey(request: Request): string | null {
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith(BEARER_PREFIX)) {
    return authHeader.slice(BEARER_PREFIX.length).trim() || null
  }

  const apiKeyHeader = request.headers.get(API_KEY_HEADER)
  if (apiKeyHeader) {
    return apiKeyHeader.trim() || null
  }

  return null
}

export const apiKeyAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!readApiKeyAuthEnabled(c.env)) {
    c.set('apiKeyRecord', null)
    return next()
  }

  const rawKey = extractRawKey(c.req.raw)

  if (!rawKey) {
    c.set('apiKeyRecord', null)
    return next()
  }

  try {
    const record = await verifyApiKey(c.env.DB, rawKey)

    if (record) {
      c.set('apiKeyRecord', record)
      return next()
    }

    // Key starts with ak_ but verification failed
    if (rawKey.startsWith('ak_')) {
      return c.json(
        {
          success: false,
          error: {
            code: 'INVALID_API_KEY',
          },
        },
        401,
      )
    }

    // Non-ak_ key that didn't verify — treat as no API key
    c.set('apiKeyRecord', null)
    return next()
  } catch {
    // DB unavailable — graceful degradation
    c.set('apiKeyRecord', null)
    return next()
  }
}
