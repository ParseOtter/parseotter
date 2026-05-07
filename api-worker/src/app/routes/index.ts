import type { Hono } from 'hono'

import type { AppEnv } from '../env'
import { registerFeedbackRoutes } from './feedback.routes'
import { registerHealthRoutes } from './health.routes'
import { registerTaskRoutes } from './tasks.routes'

export function registerRoutes(app: Hono<AppEnv>): void {
  registerHealthRoutes(app)
  registerFeedbackRoutes(app)
  registerTaskRoutes(app)
}
