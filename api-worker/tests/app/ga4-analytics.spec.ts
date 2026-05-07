import { describe, expect, it, vi } from 'vitest'

import { sanitizeGaClientId, sendGa4Event } from '../../src/app/analytics/ga4'

const GA4_ENV = {
  APP_ENV: 'production',
  GA4_ENABLED: 'true',
  GA4_MEASUREMENT_ID: 'G-XXXXXXXXXX',
  GA4_API_SECRET: 'ga4-secret',
} as const

describe('GA4 analytics', () => {
  it('sends backend events through Measurement Protocol with backend source dimensions', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))

    await sendGa4Event({
      env: GA4_ENV,
      clientId: '12345.67890',
      name: 'parseotter_conversion_completed',
      params: {
        file_type: 'application/pdf',
        file_size_bucket: '1_10mb',
        output_size_bucket: '0_1mb',
        ignored: undefined,
      },
      fetcher,
    })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined]
    expect(url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-XXXXXXXXXX&api_secret=ga4-secret')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: '12345.67890',
      events: [
        {
          name: 'parseotter_conversion_completed',
          params: {
            event_source: 'backend',
            parseotter_surface: 'backend',
            app_env: 'production',
            engagement_time_msec: 1,
            file_type: 'application/pdf',
            file_size_bucket: '1_10mb',
            output_size_bucket: '0_1mb',
          },
        },
      ],
    })
  })

  it('skips Measurement Protocol when disabled or missing a client id', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))

    await sendGa4Event({
      env: { ...GA4_ENV, GA4_ENABLED: 'false' },
      clientId: '12345.67890',
      name: 'parseotter_task_created',
      fetcher,
    })
    await sendGa4Event({
      env: GA4_ENV,
      clientId: null,
      name: 'parseotter_task_created',
      fetcher,
    })

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sanitizes GA client ids before they are stored or sent', () => {
    expect(sanitizeGaClientId(' 12345.67890 ')).toBe('12345.67890')
    expect(sanitizeGaClientId('cid:abc_DEF-123.456')).toBe('cid:abc_DEF-123.456')
    expect(sanitizeGaClientId('bad client id')).toBeNull()
    expect(sanitizeGaClientId('x'.repeat(129))).toBeNull()
  })

  it('does not throw when GA4 rejects or fails the request', async () => {
    await expect(
      sendGa4Event({
        env: GA4_ENV,
        clientId: '12345.67890',
        name: 'parseotter_task_created',
        fetcher: vi.fn(async () => {
          throw new Error('network unavailable')
        }),
      })
    ).resolves.toBeUndefined()
  })
})
