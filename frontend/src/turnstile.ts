const TURNSTILE_SCRIPT_ID = 'cf-turnstile-api'
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TURNSTILE_TIMEOUT_MS = 60_000

type TurnstileWidgetOptions = {
  sitekey: string
  execution: 'execute'
  appearance: 'interaction-only'
  callback: (token: string) => void
  'error-callback': () => void
  'expired-callback': () => void
}

type TurnstileApi = {
  render(container: HTMLElement, options: TurnstileWidgetOptions): string
  execute(widgetId: string): void
  reset(widgetId: string): void
}

type WindowWithTurnstile = Window & {
  turnstile?: TurnstileApi
}

type PendingTokenRequest = {
  resolve: (token: string) => void
  reject: (error: Error) => void
  timeoutId: number
}

type QueuedTokenRequest = Omit<PendingTokenRequest, 'timeoutId'>

let scriptPromise: Promise<TurnstileApi> | null = null

function readTurnstile(): TurnstileApi | null {
  return (window as WindowWithTurnstile).turnstile ?? null
}

function loadTurnstileScript(): Promise<TurnstileApi> {
  if (scriptPromise) {
    return scriptPromise
  }

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      const turnstile = readTurnstile()
      if (turnstile) {
        resolve(turnstile)
        return
      }
    }

    const script = existing ?? document.createElement('script')
    script.id = TURNSTILE_SCRIPT_ID
    script.src = TURNSTILE_SCRIPT_URL
    script.async = false
    script.addEventListener('load', () => {
      const turnstile = readTurnstile()
      if (!turnstile) {
        reject(new Error('Verification is unavailable. Please try again.'))
        return
      }

      resolve(turnstile)
    })
    script.addEventListener('error', () => {
      reject(new Error('Verification is unavailable. Please try again.'))
    })

    if (!existing) {
      document.head.appendChild(script)
    }
  })

  return scriptPromise
}

function createTurnstileContainer(): HTMLElement {
  const container = document.createElement('div')
  container.className = 'turnstile-host'
  document.body.appendChild(container)
  return container
}

type TurnstileTokenProvider = () => Promise<string | null>

export function createTurnstileTokenProvider(siteKey: string): TurnstileTokenProvider {
  const normalizedSiteKey = siteKey.trim()
  if (!normalizedSiteKey) {
    return async () => null
  }

  let widgetId: string | null = null
  let container: HTMLElement | null = null
  let turnstileApi: TurnstileApi | null = null
  let pending: PendingTokenRequest | null = null
  const queue: QueuedTokenRequest[] = []

  function settlePending(settle: (request: PendingTokenRequest) => void): void {
    const current = pending
    pending = null
    if (!current) {
      return
    }

    window.clearTimeout(current.timeoutId)
    settle(current)
    startNextRequest()
  }

  function startNextRequest(): void {
    if (pending) {
      return
    }

    const next = queue.shift()
    if (!next) {
      return
    }

    const currentWidgetId = widgetId
    const turnstile = turnstileApi
    if (!currentWidgetId || !turnstile) {
      next.reject(new Error('Verification is unavailable. Please try again.'))
      startNextRequest()
      return
    }

    const activeRequest: PendingTokenRequest = {
      ...next,
      timeoutId: window.setTimeout(() => {
        if (pending !== activeRequest) {
          return
        }

        pending = null
        next.reject(new Error('Verification timed out. Please try again.'))
        startNextRequest()
      }, TURNSTILE_TIMEOUT_MS),
    }
    pending = activeRequest

    try {
      turnstile.reset(currentWidgetId)
      turnstile.execute(currentWidgetId)
    } catch {
      if (pending !== activeRequest) {
        return
      }

      window.clearTimeout(activeRequest.timeoutId)
      pending = null
      next.reject(new Error('Verification failed. Please try again.'))
      startNextRequest()
    }
  }

  async function ensureWidget(): Promise<TurnstileApi> {
    const turnstile = await loadTurnstileScript()
    turnstileApi = turnstile
    if (widgetId && container) {
      return turnstile
    }

    container = createTurnstileContainer()
    widgetId = turnstile.render(container, {
      sitekey: normalizedSiteKey,
      execution: 'execute',
      appearance: 'interaction-only',
      callback: (token) => {
        settlePending((current) => current.resolve(token))
      },
      'error-callback': () => {
        settlePending((current) => current.reject(new Error('Verification failed. Please try again.')))
      },
      'expired-callback': () => {
        settlePending((current) => current.reject(new Error('Verification expired. Please try again.')))
      },
    })

    return turnstile
  }

  return async () => {
    const turnstile = await ensureWidget()
    const currentWidgetId = widgetId
    if (!currentWidgetId) {
      throw new Error('Verification is unavailable. Please try again.')
    }

    return new Promise<string>((resolve, reject) => {
      queue.push({ resolve, reject })
      startNextRequest()
    })
  }
}
