import type { Context, Hono, Next } from 'hono'

import { createClientIdentity } from '../abuse/client-identity'
import { readAbuseLimitingEnabled } from '../abuse/abuse-config'
import { recordAbuseEvent, recordRateLimitedUsage, type AbuseRoute } from '../abuse/usage'
import type { AppEnv } from '../env'
import { AppHttpError } from './errors'

type RateLimitBindingName =
  | 'CREATE_TASK_RATE_LIMITER'
  | 'UPLOAD_SESSION_RATE_LIMITER'
  | 'SIGN_PARTS_RATE_LIMITER'
  | 'COMPLETE_UPLOAD_RATE_LIMITER'
  | 'STATUS_POLL_RATE_LIMITER'
  | 'DOWNLOAD_RATE_LIMITER'
  | 'FEEDBACK_RATE_LIMITER'

type RateLimitRoute = {
  method: 'GET' | 'POST'
  route: AbuseRoute
  bindingName: RateLimitBindingName
  pattern: RegExp
}

type EnvWithOptionalRateLimits = Partial<CloudflareBindings> & Record<RateLimitBindingName, RateLimit | undefined>

const RATE_LIMIT_ROUTES: RateLimitRoute[] = [
  {
    method: 'POST',
    route: 'create_task',
    bindingName: 'CREATE_TASK_RATE_LIMITER',
    pattern: /^\/api\/tasks$/,
  },
  {
    method: 'POST',
    route: 'upload_session',
    bindingName: 'UPLOAD_SESSION_RATE_LIMITER',
    pattern: /^\/api\/tasks\/[^/]+\/uploads$/,
  },
  {
    method: 'POST',
    route: 'sign_parts',
    bindingName: 'SIGN_PARTS_RATE_LIMITER',
    pattern: /^\/api\/tasks\/[^/]+\/uploads\/[^/]+\/parts\/sign$/,
  },
  {
    method: 'POST',
    route: 'complete_upload',
    bindingName: 'COMPLETE_UPLOAD_RATE_LIMITER',
    pattern: /^\/api\/tasks\/[^/]+\/uploads\/[^/]+\/complete$/,
  },
  {
    method: 'GET',
    route: 'download',
    bindingName: 'DOWNLOAD_RATE_LIMITER',
    pattern: /^\/api\/tasks\/[^/]+\/download$/,
  },
  {
    method: 'GET',
    route: 'status_poll',
    bindingName: 'STATUS_POLL_RATE_LIMITER',
    pattern: /^\/api\/tasks\/[^/]+$/,
  },
  {
    method: 'POST',
    route: 'feedback',
    bindingName: 'FEEDBACK_RATE_LIMITER',
    pattern: /^\/api\/feedback$/,
  },
]

function matchRateLimitRoute(request: Request): RateLimitRoute | null {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()

  return RATE_LIMIT_ROUTES.find((route) => route.method === method && route.pattern.test(url.pathname)) ?? null
}

function readRateLimitBinding(env: CloudflareBindings | undefined, bindingName: RateLimitBindingName): RateLimit | null {
  if (!env) {
    return null
  }

  return (env as EnvWithOptionalRateLimits)[bindingName] ?? null
}

async function applyRateLimit(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const matchedRoute = matchRateLimitRoute(c.req.raw)
  if (!matchedRoute) {
    return next()
  }

  if (!readAbuseLimitingEnabled(c.env)) {
    return next()
  }

  const limiter = readRateLimitBinding(c.env, matchedRoute.bindingName)
  if (!limiter || !c.env?.DB) {
    return next()
  }

  const clientIdentity = await createClientIdentity(c.req.raw, c.get('requestId'))
  const result = await limiter.limit({
    key: `${matchedRoute.route}:${clientIdentity.clientHash}`,
  })

  if (result.success) {
    return next()
  }

  const now = new Date()
  await recordRateLimitedUsage(c.env.DB, {
    clientHash: clientIdentity.clientHash,
    now,
  })
  await recordAbuseEvent(c.env.DB, {
    route: matchedRoute.route,
    eventType: 'rate_limited',
    reasonCode: 'RATE_LIMITED',
    status: 429,
    clientHash: clientIdentity.clientHash,
    requestId: c.get('requestId'),
    now,
  })

  throw new AppHttpError({
    status: 429,
    code: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  })
}

export function registerRateLimitMiddleware(app: Hono<AppEnv>): void {
  app.use('*', applyRateLimit)
}
