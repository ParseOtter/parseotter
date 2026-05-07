const LOCAL_PARSEOTTER_API_BASE_URL = 'http://localhost:8787'
const LOCAL_FRONTEND_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0'])
const PLACEHOLDER_CONFIG_VALUES = new Set([
  'https://api.example.com',
  'https://your-backend.workers.dev',
  'www.example.com',
  'your-frontend.workers.dev',
  'G-XXXXXXXXXX',
])

export type RuntimeConfig = {
  parseOtterApiBaseUrl: string
  turnstileSiteKey: string
  ga4MeasurementId: string
}

export type ConfigValidationIssue = {
  field: keyof RuntimeConfig
  message: string
}

function readRuntimeHostname(): string {
  return typeof window === 'undefined' ? '' : window.location.hostname
}

function isLocalFrontendHostname(hostname: string): boolean {
  return LOCAL_FRONTEND_HOSTNAMES.has(hostname)
}

export function resolveDefaultParseOtterApiBaseUrl(hostname: string): string {
  if (isLocalFrontendHostname(hostname)) {
    return LOCAL_PARSEOTTER_API_BASE_URL
  }

  return ''
}

export function resolveDefaultGa4MeasurementId(_hostname: string): string {
  return ''
}

export const PARSEOTTER_API_BASE_URL =
  import.meta.env.VITE_PARSEOTTER_API_BASE_URL ?? resolveDefaultParseOtterApiBaseUrl(readRuntimeHostname())

export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? ''

export const GA4_MEASUREMENT_ID = import.meta.env.VITE_GA4_MEASUREMENT_ID ?? resolveDefaultGa4MeasurementId(readRuntimeHostname())

function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_CONFIG_VALUES.has(value.trim())
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateConfig(input?: Partial<RuntimeConfig>): ConfigValidationIssue[] {
  const config: RuntimeConfig = {
    parseOtterApiBaseUrl: PARSEOTTER_API_BASE_URL,
    turnstileSiteKey: TURNSTILE_SITE_KEY,
    ga4MeasurementId: GA4_MEASUREMENT_ID,
    ...input,
  }
  const issues: ConfigValidationIssue[] = []
  const parseOtterApiBaseUrl = config.parseOtterApiBaseUrl.trim()
  const turnstileSiteKey = config.turnstileSiteKey.trim()
  const ga4MeasurementId = config.ga4MeasurementId.trim()

  if (!parseOtterApiBaseUrl) {
    issues.push({
      field: 'parseOtterApiBaseUrl',
      message: 'VITE_PARSEOTTER_API_BASE_URL is empty.',
    })
  } else if (!isHttpUrl(parseOtterApiBaseUrl)) {
    issues.push({
      field: 'parseOtterApiBaseUrl',
      message: 'VITE_PARSEOTTER_API_BASE_URL must be an absolute HTTP(S) URL.',
    })
  } else if (isPlaceholderValue(parseOtterApiBaseUrl)) {
    issues.push({
      field: 'parseOtterApiBaseUrl',
      message: 'VITE_PARSEOTTER_API_BASE_URL still uses a placeholder value.',
    })
  }

  if (!turnstileSiteKey) {
    issues.push({
      field: 'turnstileSiteKey',
      message: 'VITE_TURNSTILE_SITE_KEY is empty; upload verification will be skipped.',
    })
  }

  if (ga4MeasurementId) {
    if (isPlaceholderValue(ga4MeasurementId)) {
      issues.push({
        field: 'ga4MeasurementId',
        message: 'VITE_GA4_MEASUREMENT_ID still uses a placeholder value.',
      })
    } else if (!/^G-[A-Z0-9]+$/i.test(ga4MeasurementId)) {
      issues.push({
        field: 'ga4MeasurementId',
        message: 'VITE_GA4_MEASUREMENT_ID should look like a GA4 measurement id.',
      })
    }
  }

  return issues
}

export function validateDeployConfig(input?: Partial<RuntimeConfig> & { hostname?: string }): ConfigValidationIssue[] {
  const hostname = input?.hostname ?? readRuntimeHostname()
  if (isLocalFrontendHostname(hostname)) {
    return []
  }

  const config: RuntimeConfig = {
    parseOtterApiBaseUrl: PARSEOTTER_API_BASE_URL,
    turnstileSiteKey: TURNSTILE_SITE_KEY,
    ga4MeasurementId: GA4_MEASUREMENT_ID,
    ...input,
  }
  const issues: ConfigValidationIssue[] = []
  const parseOtterApiBaseUrl = config.parseOtterApiBaseUrl.trim()
  const ga4MeasurementId = config.ga4MeasurementId.trim()

  if (!parseOtterApiBaseUrl) {
    issues.push({
      field: 'parseOtterApiBaseUrl',
      message: 'VITE_PARSEOTTER_API_BASE_URL is required for deployed frontend hostnames.',
    })
  } else if (!isHttpUrl(parseOtterApiBaseUrl)) {
    issues.push({
      field: 'parseOtterApiBaseUrl',
      message: 'VITE_PARSEOTTER_API_BASE_URL must be an absolute HTTP(S) URL.',
    })
  } else if (isPlaceholderValue(parseOtterApiBaseUrl)) {
    issues.push({
      field: 'parseOtterApiBaseUrl',
      message: 'VITE_PARSEOTTER_API_BASE_URL still uses a placeholder value.',
    })
  }

  if (ga4MeasurementId) {
    if (isPlaceholderValue(ga4MeasurementId)) {
      issues.push({
        field: 'ga4MeasurementId',
        message: 'VITE_GA4_MEASUREMENT_ID still uses a placeholder value.',
      })
    } else if (!/^G-[A-Z0-9]+$/i.test(ga4MeasurementId)) {
      issues.push({
        field: 'ga4MeasurementId',
        message: 'VITE_GA4_MEASUREMENT_ID should look like a GA4 measurement id.',
      })
    }
  }

  return issues
}

export function reportConfigValidationIssues(issues = validateConfig()): void {
  if (issues.length === 0) {
    return
  }

  console.warn(
    [
      'ParseOtter frontend config has development warnings:',
      ...issues.map((issue) => `- ${issue.message}`),
    ].join('\n')
  )
}

export function assertDeployConfig(issues = validateDeployConfig()): void {
  if (issues.length === 0) {
    return
  }

  throw new Error(
    [
      'ParseOtter frontend deploy config is invalid:',
      ...issues.map((issue) => `- ${issue.message}`),
    ].join('\n')
  )
}

if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
  reportConfigValidationIssues()
}

if (import.meta.env.PROD) {
  assertDeployConfig()
}
