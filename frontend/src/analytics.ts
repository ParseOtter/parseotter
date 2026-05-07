import { GA4_MEASUREMENT_ID } from './config'

type AnalyticsValue = string | number | boolean | null | undefined
type AnalyticsParams = Record<string, AnalyticsValue>
type NormalizedAnalyticsParams = Record<string, string | number | boolean>

type MeasurementInput = {
  measurementId?: string
}

type ClientIdInput = MeasurementInput & {
  timeoutMs?: number
}

declare global {
  interface Window {
    dataLayer?: unknown[][]
    gtag?: (...args: unknown[]) => void
  }
}

const GA_CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
const configuredMeasurementIds = new Set<string>()
let latestMeasurementId = ''

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function normalizeMeasurementId(measurementId: string | null | undefined): string {
  return typeof measurementId === 'string' ? measurementId.trim() : ''
}

function resolveMeasurementId(input?: MeasurementInput): string {
  return normalizeMeasurementId(input?.measurementId ?? GA4_MEASUREMENT_ID)
}

function resolveEventMeasurementId(): string {
  return normalizeMeasurementId(GA4_MEASUREMENT_ID || latestMeasurementId)
}

function hasGtagScript(measurementId: string): boolean {
  return Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[data-ga4-measurement-id]')).some(
    (script) => script.dataset.ga4MeasurementId === measurementId
  )
}

function normalizeAnalyticsParams(params: AnalyticsParams): NormalizedAnalyticsParams {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    })
  )
}

function getFileSizeBucket(fileSizeBytes: number): string {
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

function sanitizeGaClientId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return GA_CLIENT_ID_PATTERN.test(trimmed) ? trimmed : null
}

export function initializeAnalytics(input?: MeasurementInput): void {
  const measurementId = resolveMeasurementId(input)
  if (!measurementId || !isBrowser()) {
    return
  }

  latestMeasurementId = measurementId
  window.dataLayer = window.dataLayer ?? []
  window.gtag =
    window.gtag ??
    function gtag(...args: unknown[]): void {
      window.dataLayer?.push(args)
    }

  const alreadyConfigured = configuredMeasurementIds.has(measurementId) && hasGtagScript(measurementId)

  if (!hasGtagScript(measurementId)) {
    const script = document.createElement('script')
    script.async = true
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`
    script.dataset.ga4MeasurementId = measurementId
    document.head.appendChild(script)
  }

  if (alreadyConfigured) {
    return
  }

  window.gtag('js', new Date())
  window.gtag('config', measurementId, { send_page_view: true })
  configuredMeasurementIds.add(measurementId)
}

function trackFrontendEvent(name: string, params: AnalyticsParams = {}): void {
  const measurementId = resolveEventMeasurementId()
  if (!measurementId || !isBrowser()) {
    return
  }

  initializeAnalytics({ measurementId })
  window.gtag?.(
    'event',
    name,
    normalizeAnalyticsParams({
      event_source: 'frontend',
      parseotter_surface: 'frontend',
      ...params,
    })
  )
}

export function trackFileSelected(input: { fileType: string; fileSizeBytes: number }): void {
  trackFrontendEvent(
    'parseotter_file_selected',
    {
      file_type: input.fileType,
      file_size_bucket: getFileSizeBucket(input.fileSizeBytes),
    }
  )
}

export function trackBeginConversion(input: { fileCount: number }): void {
  trackFrontendEvent(
    'parseotter_begin_conversion',
    {
      file_count: input.fileCount,
    }
  )
}

export function trackDownloadResult(input: { status: 'success' | 'error' }): void {
  trackFrontendEvent(
    'parseotter_download_result',
    {
      status: input.status,
    }
  )
}

export function trackFeedbackOpened(): void {
  trackFrontendEvent('parseotter_feedback_opened')
}

export function trackFeedbackSubmitted(input: { category: string; rating: number | null }): void {
  trackFrontendEvent(
    'parseotter_feedback_submitted',
    {
      feedback_category: input.category,
      rating: input.rating,
    }
  )
}

export async function getGaClientId(input?: ClientIdInput): Promise<string | null> {
  const measurementId = resolveMeasurementId(input)
  if (!measurementId || !isBrowser()) {
    return null
  }

  initializeAnalytics({ measurementId })

  return new Promise((resolve) => {
    let settled = false
    const timeout = window.setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    }, input?.timeoutMs ?? 300)

    try {
      window.gtag?.('get', measurementId, 'client_id', (clientId: unknown) => {
        if (settled) {
          return
        }

        settled = true
        window.clearTimeout(timeout)
        resolve(sanitizeGaClientId(clientId))
      })
    } catch {
      if (!settled) {
        settled = true
        window.clearTimeout(timeout)
        resolve(null)
      }
    }
  })
}
