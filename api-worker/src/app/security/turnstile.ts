import { readStringEnv, splitCsv } from '../../lib/env'
import { AppHttpError } from '../http/errors'
import { readTurnstileEnabled } from '../abuse/abuse-config'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const MAX_TURNSTILE_TOKEN_LENGTH = 2048

type TurnstileSiteverifyResponse = {
  success?: boolean
  challenge_ts?: string
  hostname?: string
  action?: string
  'error-codes'?: string[]
}

function createTurnstileFailedError(): AppHttpError {
  return new AppHttpError({
    status: 403,
    code: 'TURNSTILE_FAILED',
    message: 'Verification failed. Please try again.',
  })
}

export function readTurnstileSecretKey(env: Partial<CloudflareBindings>): string | null {
  return readStringEnv(env, 'TURNSTILE_SECRET_KEY')
}

export async function verifyTurnstileToken(input: {
  env: Partial<CloudflareBindings>
  token: string | null
  remoteIp: string | null
}): Promise<void> {
  if (!readTurnstileEnabled(input.env)) {
    return
  }

  const token = input.token?.trim()
  if (!token || token.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    throw createTurnstileFailedError()
  }

  const secret = readTurnstileSecretKey(input.env)
  if (!secret) {
    throw createTurnstileFailedError()
  }

  const body = new FormData()
  body.set('secret', secret)
  body.set('response', token)
  body.set('idempotency_key', crypto.randomUUID())
  if (input.remoteIp) {
    body.set('remoteip', input.remoteIp)
  }

  let result: TurnstileSiteverifyResponse
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
    })
    result = (await response.json()) as TurnstileSiteverifyResponse
  } catch {
    throw createTurnstileFailedError()
  }

  if (!result.success) {
    throw createTurnstileFailedError()
  }

  const expectedHostnames = splitCsv(readStringEnv(input.env, 'TURNSTILE_EXPECTED_HOSTNAMES'))
  if (expectedHostnames.length > 0 && (!result.hostname || !expectedHostnames.includes(result.hostname))) {
    throw createTurnstileFailedError()
  }
}
