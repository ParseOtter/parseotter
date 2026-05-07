import { describe, expect, it } from 'vitest'

import {
  resolveDefaultGa4MeasurementId,
  resolveDefaultParseOtterApiBaseUrl,
  validateConfig,
  validateDeployConfig,
} from '../src/config'

describe('frontend runtime config', () => {
  it('requires explicit API env configuration for deployed hostnames', () => {
    expect(resolveDefaultParseOtterApiBaseUrl('www.example.com')).toBe('')
    expect(resolveDefaultParseOtterApiBaseUrl('your-frontend.workers.dev')).toBe('')
    expect(resolveDefaultParseOtterApiBaseUrl('preview.example.com')).toBe('')
  })

  it('keeps localhost backend as the local development default', () => {
    expect(resolveDefaultParseOtterApiBaseUrl('127.0.0.1')).toBe('http://localhost:8787')
    expect(resolveDefaultParseOtterApiBaseUrl('localhost')).toBe('http://localhost:8787')
  })

  it('keeps GA4 env-only for deployed hostnames', () => {
    expect(resolveDefaultGa4MeasurementId('www.example.com')).toBe('')
    expect(resolveDefaultGa4MeasurementId('localhost')).toBe('')
    expect(resolveDefaultGa4MeasurementId('your-frontend.workers.dev')).toBe('')
  })

  it('reports placeholder and missing development config values', () => {
    expect(
      validateConfig({
        parseOtterApiBaseUrl: 'https://api.example.com',
        turnstileSiteKey: '',
        ga4MeasurementId: 'G-XXXXXXXXXX',
      })
    ).toEqual([
      {
        field: 'parseOtterApiBaseUrl',
        message: 'VITE_PARSEOTTER_API_BASE_URL still uses a placeholder value.',
      },
      {
        field: 'turnstileSiteKey',
        message: 'VITE_TURNSTILE_SITE_KEY is empty; upload verification will be skipped.',
      },
      {
        field: 'ga4MeasurementId',
        message: 'VITE_GA4_MEASUREMENT_ID still uses a placeholder value.',
      },
    ])
  })

  it('accepts concrete runtime config values', () => {
    expect(
      validateConfig({
        parseOtterApiBaseUrl: 'https://convert-api.example.net',
        turnstileSiteKey: '0x4AAAAAAABBBBBBBBBBBBBB',
        ga4MeasurementId: 'G-ABC123DEF4',
      })
    ).toEqual([])
  })

  it('allows local hostname defaults for deploy validation', () => {
    expect(
      validateDeployConfig({
        hostname: 'localhost',
        parseOtterApiBaseUrl: 'http://localhost:8787',
        turnstileSiteKey: '',
        ga4MeasurementId: '',
      })
    ).toEqual([])
  })

  it('blocks deployed hostnames without an explicit API base URL', () => {
    expect(
      validateDeployConfig({
        hostname: 'www.parseotter.example',
        parseOtterApiBaseUrl: '',
        turnstileSiteKey: '',
        ga4MeasurementId: '',
      })
    ).toEqual([
      {
        field: 'parseOtterApiBaseUrl',
        message: 'VITE_PARSEOTTER_API_BASE_URL is required for deployed frontend hostnames.',
      },
    ])
  })

  it('blocks placeholder deployed config values', () => {
    expect(
      validateDeployConfig({
        hostname: 'www.parseotter.example',
        parseOtterApiBaseUrl: 'https://api.example.com',
        turnstileSiteKey: '',
        ga4MeasurementId: 'G-XXXXXXXXXX',
      })
    ).toEqual([
      {
        field: 'parseOtterApiBaseUrl',
        message: 'VITE_PARSEOTTER_API_BASE_URL still uses a placeholder value.',
      },
      {
        field: 'ga4MeasurementId',
        message: 'VITE_GA4_MEASUREMENT_ID still uses a placeholder value.',
      },
    ])
  })

  it('accepts concrete deployed config values without requiring Turnstile', () => {
    expect(
      validateDeployConfig({
        hostname: 'www.parseotter.example',
        parseOtterApiBaseUrl: 'https://convert-api.example.net',
        turnstileSiteKey: '',
        ga4MeasurementId: 'G-ABC123DEF4',
      })
    ).toEqual([])
  })
})
