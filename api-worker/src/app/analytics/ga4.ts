import type { TaskSnapshot } from '../tasks/task-status'

export type Ga4EventName =
  | 'parseotter_task_created'
  | 'parseotter_upload_completed'
  | 'parseotter_conversion_completed'
  | 'parseotter_conversion_failed'

type Ga4Env = Partial<CloudflareBindings> & {
  APP_ENV?: string
  GA4_ENABLED?: string
  GA4_MEASUREMENT_ID?: string
  GA4_API_SECRET?: string
}

type Ga4ParamValue = string | number | boolean | null | undefined
type Ga4Params = Record<string, Ga4ParamValue>
type NormalizedGa4Params = Record<string, string | number | boolean>
type Ga4Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Ga4Config = {
  measurementId: string
  apiSecret: string
  appEnv: string
}

const GA4_COLLECT_URL = 'https://www.google-analytics.com/mp/collect'
const GA_CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

function readGa4Config(env: Ga4Env): Ga4Config | null {
  if (env.GA4_ENABLED !== 'true') {
    return null
  }

  const measurementId = env.GA4_MEASUREMENT_ID?.trim()
  const apiSecret = env.GA4_API_SECRET?.trim()
  if (!measurementId || !apiSecret) {
    return null
  }

  return {
    measurementId,
    apiSecret,
    appEnv: env.APP_ENV?.trim() || 'unknown',
  }
}

function normalizeGa4Params(params: Ga4Params): NormalizedGa4Params {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    })
  )
}

function createCollectUrl(config: Ga4Config): string {
  const url = new URL(GA4_COLLECT_URL)
  url.searchParams.set('measurement_id', config.measurementId)
  url.searchParams.set('api_secret', config.apiSecret)
  return url.toString()
}

export function sanitizeGaClientId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return GA_CLIENT_ID_PATTERN.test(trimmed) ? trimmed : null
}

export function getFileSizeBucket(fileSizeBytes: number | null): string | undefined {
  if (fileSizeBytes === null || !Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
    return undefined
  }

  const mb = 1024 * 1024
  if (fileSizeBytes < mb) {
    return '0_1mb'
  }
  if (fileSizeBytes < 10 * mb) {
    return '1_10mb'
  }
  if (fileSizeBytes < 50 * mb) {
    return '10_50mb'
  }
  if (fileSizeBytes < 100 * mb) {
    return '50_100mb'
  }
  return '100mb_plus'
}

export async function sendGa4Event(input: {
  env: Ga4Env
  clientId: string | null
  name: Ga4EventName
  params?: Ga4Params
  fetcher?: Ga4Fetcher
}): Promise<void> {
  const config = readGa4Config(input.env)
  const clientId = sanitizeGaClientId(input.clientId)
  if (!config || !clientId) {
    return
  }

  const body = JSON.stringify({
    client_id: clientId,
    events: [
      {
        name: input.name,
        params: normalizeGa4Params({
          event_source: 'backend',
          parseotter_surface: 'backend',
          app_env: config.appEnv,
          engagement_time_msec: 1,
          ...input.params,
        }),
      },
    ],
  })

  try {
    const fetcher = input.fetcher ?? globalThis.fetch
    await fetcher(createCollectUrl(config), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body,
    })
  } catch {
    // Analytics must never change conversion task state or user-facing responses.
  }
}

export async function sendGa4TaskEvent(input: {
  env: Ga4Env
  snapshot: TaskSnapshot
  name: Ga4EventName
  params?: Ga4Params
}): Promise<void> {
  await sendGa4Event({
    env: input.env,
    clientId: input.snapshot.gaClientId,
    name: input.name,
    params: {
      task_status: input.snapshot.status,
      file_type: input.snapshot.fileType,
      file_size_bucket: getFileSizeBucket(input.snapshot.fileSizeBytes),
      output_size_bucket: getFileSizeBucket(input.snapshot.outputSizeBytes),
      task_attempt: input.snapshot.attempt,
      error_code: input.snapshot.errorCode,
      ...input.params,
    },
  })
}
