import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getGaClientId,
  initializeAnalytics,
  trackBeginConversion,
  trackDownloadResult,
  trackFileSelected,
} from '../src/analytics'

function getPageViewConfigCalls(): unknown[][] {
  return (window.dataLayer ?? []).filter(
    (args) => args[0] === 'config' && typeof args[1] === 'string' && (args[2] as { send_page_view?: unknown })?.send_page_view === true
  )
}

describe('frontend analytics', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    delete window.dataLayer
    delete window.gtag
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads gtag once for the configured measurement id', () => {
    initializeAnalytics({ measurementId: 'G-XXXXXXXXXX' })
    initializeAnalytics({ measurementId: 'G-XXXXXXXXXX' })

    const scripts = document.head.querySelectorAll('script[src^="https://www.googletagmanager.com/gtag/js"]')
    expect(scripts).toHaveLength(1)
    expect(scripts[0].getAttribute('src')).toBe('https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX')
    expect(window.dataLayer).toContainEqual(['config', 'G-XXXXXXXXXX', { send_page_view: true }])
    expect(getPageViewConfigCalls()).toHaveLength(1)
  })

  it('adds source dimensions to frontend events without file names', () => {
    initializeAnalytics({ measurementId: 'G-XXXXXXXXXX' })

    trackFileSelected({
      fileType: 'application/pdf',
      fileSizeBytes: 6 * 1024 * 1024,
    })
    trackBeginConversion({ fileCount: 2 })
    trackDownloadResult({ status: 'success' })

    expect(window.dataLayer).toContainEqual([
      'event',
      'parseotter_file_selected',
      {
        event_source: 'frontend',
        parseotter_surface: 'frontend',
        file_type: 'application/pdf',
        file_size_bucket: '1_10mb',
      },
    ])
    expect(window.dataLayer).toContainEqual([
      'event',
      'parseotter_begin_conversion',
      {
        event_source: 'frontend',
        parseotter_surface: 'frontend',
        file_count: 2,
      },
    ])
    expect(window.dataLayer).toContainEqual([
      'event',
      'parseotter_download_result',
      {
        event_source: 'frontend',
        parseotter_surface: 'frontend',
        status: 'success',
      },
    ])
    expect(JSON.stringify(window.dataLayer)).not.toContain('sample.pdf')
    expect(getPageViewConfigCalls()).toHaveLength(1)
  })

  it('resolves the GA client id through gtag get', async () => {
    initializeAnalytics({ measurementId: 'G-XXXXXXXXXX' })
    window.gtag = vi.fn((command: string, _measurementId: string, fieldName: string, callback: (value: string) => void) => {
      if (command === 'get' && fieldName === 'client_id') {
        callback('12345.67890')
      }
    }) as typeof window.gtag

    await expect(getGaClientId({ measurementId: 'G-XXXXXXXXXX', timeoutMs: 1000 })).resolves.toBe('12345.67890')
  })

  it('does not emit another page view when later events reuse initialized analytics', () => {
    initializeAnalytics({ measurementId: 'G-TEST123456' })
    trackBeginConversion({ fileCount: 3 })
    trackDownloadResult({ status: 'error' })

    expect(getPageViewConfigCalls()).toEqual([['config', 'G-TEST123456', { send_page_view: true }]])
    expect(window.dataLayer).toContainEqual([
      'event',
      'parseotter_begin_conversion',
      {
        event_source: 'frontend',
        parseotter_surface: 'frontend',
        file_count: 3,
      },
    ])
  })

  it('lets GA client id initialization share the existing page view config', async () => {
    initializeAnalytics({ measurementId: 'G-CLIENT1234' })
    window.gtag = vi.fn((command: string, _measurementId: string, fieldName: string, callback: (value: string) => void) => {
      if (command === 'get' && fieldName === 'client_id') {
        callback('client.123')
      }
    }) as typeof window.gtag

    await expect(getGaClientId({ measurementId: 'G-CLIENT1234', timeoutMs: 1000 })).resolves.toBe('client.123')
    expect(getPageViewConfigCalls()).toEqual([['config', 'G-CLIENT1234', { send_page_view: true }]])
  })

  it('returns null when the GA client id is unavailable', async () => {
    initializeAnalytics({ measurementId: 'G-XXXXXXXXXX' })

    const clientIdPromise = getGaClientId({ measurementId: 'G-XXXXXXXXXX', timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)

    await expect(clientIdPromise).resolves.toBeNull()
  })
})
