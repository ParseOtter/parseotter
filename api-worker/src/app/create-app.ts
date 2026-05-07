import { Hono } from 'hono'

import type { AppEnv } from './env'
import { registerCorsMiddleware } from './http/cors'
import { registerErrorHandlers } from './http/error-handlers'
import { registerRateLimitMiddleware } from './http/rate-limit'
import { requestContextMiddleware } from './http/request-context'
import { registerRoutes } from './routes'

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use('*', requestContextMiddleware)
  registerCorsMiddleware(app)
  registerRateLimitMiddleware(app)
  registerRoutes(app)
  registerErrorHandlers(app)

  return app
}
