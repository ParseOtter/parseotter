import type { Hono } from 'hono'

import type { AppEnv } from '../env'
import { AppHttpError, normalizeAppError } from './errors'
import { jsonError } from './responses'

export function registerErrorHandlers(app: Hono<AppEnv>): void {
  app.notFound((c) => {
    return jsonError(
      new AppHttpError({
        status: 404,
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist',
      }),
      c.get('requestId')
    )
  })

  app.onError((error, c) => {
    const normalizedError = normalizeAppError(error)
    c.set('requestError', normalizedError)

    return jsonError(normalizedError, c.get('requestId'))
  })
}
