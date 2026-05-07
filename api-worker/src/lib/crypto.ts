type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean
}

const textEncoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', textEncoder.encode(value))
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await sha256(value)))
}

export async function hmacSha256(key: string | ArrayBuffer, payload: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? textEncoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  return crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(payload))
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  return bytesToHex(new Uint8Array(await hmacSha256(secret, payload)))
}

function constantTimeEqualFallback(left: Uint8Array, right: Uint8Array): boolean {
  const maxLength = Math.max(left.byteLength, right.byteLength)
  let diff = left.byteLength ^ right.byteLength

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return diff === 0
}

export async function constantTimeStringEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)])
  const subtle = crypto.subtle as TimingSafeSubtleCrypto

  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(leftHash, rightHash)
  }

  return constantTimeEqualFallback(new Uint8Array(leftHash), new Uint8Array(rightHash))
}
