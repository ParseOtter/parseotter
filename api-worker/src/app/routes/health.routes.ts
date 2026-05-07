import type { Hono } from 'hono'

import type { AppEnv } from '../env'
import { jsonSuccess } from '../http/responses'

export function registerHealthRoutes(app: Hono<AppEnv>): void {
  app.get('/health', (c) => {
    return jsonSuccess(
      {
        status: 'ok',
        service: 'parseotter-api',
        runtime: 'cloudflare-worker',
        timestamp: new Date().toISOString(),
      },
      {
        requestId: c.get('requestId'),
      }
    )
  })
}
