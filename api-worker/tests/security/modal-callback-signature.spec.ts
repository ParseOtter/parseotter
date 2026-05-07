import { describe, expect, it } from 'vitest'

import { signModalCallbackBody, verifyModalCallbackSignature } from '../../src/app/security/modal-callback-signature'

describe('Modal callback HMAC signatures', () => {
  it('accepts a valid HMAC signature inside the timestamp window', async () => {
    const secret = 'test-callback-secret'
    const body = JSON.stringify({ jobId: 'task_abc', status: 'completed' })
    const timestamp = '1800000000'
    const signature = await signModalCallbackBody({ body, secret, timestamp })

    await expect(
      verifyModalCallbackSignature({
        body,
        secret,
        signature,
        timestamp,
        nowMs: 1_800_000_100_000,
        toleranceSeconds: 300,
      })
    ).resolves.toEqual({ valid: true })
  })

  it('rejects an invalid HMAC signature using a constant-time comparison path', async () => {
    const secret = 'test-callback-secret'
    const body = JSON.stringify({ jobId: 'task_abc', status: 'completed' })
    const timestamp = '1800000000'

    await expect(
      verifyModalCallbackSignature({
        body,
        secret,
        signature: 'bad-signature',
        timestamp,
        nowMs: 1_800_000_100_000,
        toleranceSeconds: 300,
      })
    ).resolves.toEqual({ valid: false, reason: 'SIGNATURE_INVALID' })
  })

  it('rejects stale timestamps before comparing callback authority', async () => {
    const secret = 'test-callback-secret'
    const body = JSON.stringify({ jobId: 'task_abc', status: 'completed' })
    const timestamp = '1800000000'
    const signature = await signModalCallbackBody({ body, secret, timestamp })

    await expect(
      verifyModalCallbackSignature({
        body,
        secret,
        signature,
        timestamp,
        nowMs: 1_800_001_000_000,
        toleranceSeconds: 300,
      })
    ).resolves.toEqual({ valid: false, reason: 'TIMESTAMP_EXPIRED' })
  })
})
