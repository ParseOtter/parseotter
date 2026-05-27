import { beforeEach, describe, expect, it, vi } from 'vitest'

import { verifyApiKey } from '../../src/app/security/api-key'
import { sha256Hex } from '../../src/lib/crypto'

const VALID_RAW_KEY = 'ak_test_key_abc1234567890'

function createMockD1Database(firstResult: Record<string, unknown> | null): D1Database {
  const runResult = { success: true, meta: {} }
  const preparedStatement = {
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(firstResult),
      run: vi.fn().mockResolvedValue(runResult),
    }),
  }

  return {
    prepare: vi.fn().mockReturnValue(preparedStatement),
  } as unknown as D1Database
}

describe('verifyApiKey', () => {
  let expectedHash: string

  beforeEach(async () => {
    expectedHash = await sha256Hex(VALID_RAW_KEY)
  })

  it('returns the ApiKeyRecord when the key is valid and not revoked', async () => {
    const row = {
      key_id: 'kid_001',
      key_prefix: 'ak_t',
      owner_label: 'CI pipeline',
      revoked_at: null,
    }
    const db = createMockD1Database(row)

    const result = await verifyApiKey(db, VALID_RAW_KEY)

    expect(result).toEqual({
      keyId: 'kid_001',
      keyPrefix: 'ak_t',
      ownerLabel: 'CI pipeline',
      revokedAt: null,
    })
    expect(db.prepare).toHaveBeenCalledWith(
      'SELECT key_id, key_prefix, owner_label, revoked_at FROM parseotter_api_keys WHERE key_hash = ?'
    )
    expect((db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind).toHaveBeenCalledWith(expectedHash)
  })

  it('returns null when the key has been revoked', async () => {
    const row = {
      key_id: 'kid_revoked',
      key_prefix: 'ak_t',
      owner_label: 'Old CI key',
      revoked_at: '2026-01-15T00:00:00.000Z',
    }
    const db = createMockD1Database(row)

    const result = await verifyApiKey(db, VALID_RAW_KEY)

    expect(result).toBeNull()
  })

  it('returns null when the key hash does not match any row', async () => {
    const db = createMockD1Database(null)

    const result = await verifyApiKey(db, VALID_RAW_KEY)

    expect(result).toBeNull()
  })

  it('returns null when the raw key lacks the ak_ prefix', async () => {
    const db = createMockD1Database(null)

    const result = await verifyApiKey(db, 'no_prefix_key_1234567890')

    expect(result).toBeNull()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('returns null when the raw key is shorter than 20 characters', async () => {
    const db = createMockD1Database(null)

    const result = await verifyApiKey(db, 'ak_short')

    expect(result).toBeNull()
    expect(db.prepare).not.toHaveBeenCalled()
  })
})
