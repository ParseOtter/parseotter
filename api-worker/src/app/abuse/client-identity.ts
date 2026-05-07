import { sha256Hex } from '../../lib/crypto'

const MAX_CLIENT_USER_AGENT_LENGTH = 500
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/

export type ClientIdentity = {
  clientHash: string
  clientIpHash: string
  userAgent: string | null
  remoteIp: string | null
}

function truncateOptional(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function readClientAddress(request: Request): string | null {
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim()
  if (connectingIp) {
    return connectingIp
  }

  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwardedFor && forwardedFor.length > 0 ? forwardedFor : null
}

export function readClientUserAgent(request: Request): string | null {
  return truncateOptional(request.headers.get('user-agent')?.trim() ?? null, MAX_CLIENT_USER_AGENT_LENGTH)
}

export async function createClientIdentity(request: Request, fallbackId?: string | null): Promise<ClientIdentity> {
  const remoteIp = readClientAddress(request)
  const userAgent = readClientUserAgent(request)
  const localFallback = request.headers.get('x-request-id')?.trim() || fallbackId?.trim()
  const ipMaterial = remoteIp ?? (localFallback ? `request:${localFallback}` : 'unknown')
  const userAgentMaterial = userAgent ?? 'unknown'

  return {
    clientHash: await sha256Hex(`${ipMaterial}\n${userAgentMaterial}`),
    clientIpHash: await sha256Hex(ipMaterial),
    userAgent,
    remoteIp,
  }
}

export function isClientHash(value: string | null): value is string {
  return typeof value === 'string' && HEX_SHA256_PATTERN.test(value)
}
