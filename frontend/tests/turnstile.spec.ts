import { afterEach, describe, expect, it, vi } from 'vitest'

type RenderOptions = {
  callback: (token: string) => void
}

describe('turnstile token provider', () => {
  afterEach(() => {
    vi.resetModules()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    Reflect.deleteProperty(window, 'turnstile')
  })

  it('loads explicit Turnstile without async/defer and resolves an executed token', async () => {
    const { createTurnstileTokenProvider } = await import('../src/turnstile')
    let renderOptions: RenderOptions | null = null
    const turnstile = {
      render: vi.fn((_container: HTMLElement, options: RenderOptions) => {
        renderOptions = options
        return 'widget-id'
      }),
      reset: vi.fn(),
      execute: vi.fn(() => {
        renderOptions?.callback('turnstile-token')
      }),
    }
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: turnstile,
    })
    const getToken = createTurnstileTokenProvider('site-key')
    const tokenPromise = getToken()
    const script = document.getElementById('cf-turnstile-api') as HTMLScriptElement | null

    expect(script).not.toBeNull()
    expect(script?.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    expect(script?.async).toBe(false)
    expect(script?.defer).toBe(false)
    expect(script?.hasAttribute('async')).toBe(false)
    expect(script?.hasAttribute('defer')).toBe(false)

    script?.dispatchEvent(new Event('load'))

    await expect(tokenPromise).resolves.toBe('turnstile-token')
    expect(turnstile.render).toHaveBeenCalledOnce()
    expect(turnstile.reset).toHaveBeenCalledWith('widget-id')
    expect(turnstile.execute).toHaveBeenCalledWith('widget-id')
  })

  it('serializes concurrent token requests through one widget', async () => {
    const { createTurnstileTokenProvider } = await import('../src/turnstile')
    let renderOptions: RenderOptions | null = null
    const turnstile = {
      render: vi.fn((_container: HTMLElement, options: RenderOptions) => {
        renderOptions = options
        return 'widget-id'
      }),
      reset: vi.fn(),
      execute: vi.fn(),
    }
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: turnstile,
    })
    const getRenderOptions = (): RenderOptions => {
      if (!renderOptions) {
        throw new Error('Turnstile render options were not captured')
      }

      return renderOptions
    }

    const getToken = createTurnstileTokenProvider('site-key')
    const firstTokenPromise = getToken()
    const secondTokenPromise = getToken()

    document.getElementById('cf-turnstile-api')?.dispatchEvent(new Event('load'))
    await vi.waitFor(() => {
      expect(turnstile.execute).toHaveBeenCalledTimes(1)
    })

    getRenderOptions().callback('first-token')
    await expect(firstTokenPromise).resolves.toBe('first-token')
    expect(turnstile.execute).toHaveBeenCalledTimes(2)

    getRenderOptions().callback('second-token')
    await expect(secondTokenPromise).resolves.toBe('second-token')
    expect(turnstile.render).toHaveBeenCalledOnce()
    expect(turnstile.reset).toHaveBeenCalledTimes(2)
  })
})
