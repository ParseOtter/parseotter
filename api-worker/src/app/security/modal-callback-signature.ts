import { constantTimeStringEqual, hmacSha256Hex } from '../../lib/crypto'

const SIGNATURE_PAYLOAD_SEPARATOR = '.'

export type ModalCallbackSignatureInput = {
  body: string
  secret: string
  timestamp: string
}

export type ModalCallbackVerificationInput = ModalCallbackSignatureInput & {
  signature: string
  nowMs?: number
  toleranceSeconds?: number
}

export type ModalCallbackVerificationResult =
  | { valid: true }
  | {
      valid: false
      reason: 'SECRET_MISSING' | 'TIMESTAMP_INVALID' | 'TIMESTAMP_EXPIRED' | 'SIGNATURE_INVALID'
    }

function parseTimestampSeconds(timestamp: string): number | null {
  if (!/^\d+$/.test(timestamp)) {
    return null
  }

  const parsed = Number(timestamp)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export async function signModalCallbackBody(input: ModalCallbackSignatureInput): Promise<string> {
  return hmacSha256Hex(input.secret, `${input.timestamp}${SIGNATURE_PAYLOAD_SEPARATOR}${input.body}`)
}

export async function verifyModalCallbackSignature(
  input: ModalCallbackVerificationInput
): Promise<ModalCallbackVerificationResult> {
  if (input.secret.trim().length === 0) {
    return { valid: false, reason: 'SECRET_MISSING' }
  }

  const timestampSeconds = parseTimestampSeconds(input.timestamp)
  if (timestampSeconds === null) {
    return { valid: false, reason: 'TIMESTAMP_INVALID' }
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const toleranceSeconds = input.toleranceSeconds ?? 300
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { valid: false, reason: 'TIMESTAMP_EXPIRED' }
  }

  const expectedSignature = await signModalCallbackBody(input)
  const signaturesMatch = await constantTimeStringEqual(input.signature, expectedSignature)

  return signaturesMatch ? { valid: true } : { valid: false, reason: 'SIGNATURE_INVALID' }
}
