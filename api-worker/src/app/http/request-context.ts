import type { MiddlewareHandler } from 'hono'

import type { AppEnv } from '../env'
import { resolveRequestId } from './request-id'

export const requestContextMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('requestId', resolveRequestId(c.req.raw))
  c.set('requestError', null)

  await next()
}
