import { sha256Hex } from '../../lib/crypto'

export type ApiKeyRecord = {
  keyId: string
  keyPrefix: string
  ownerLabel: string | null
  revokedAt: string | null
}

type ApiKeyRow = {
  key_id: string
  key_prefix: string
  owner_label: string | null
  revoked_at: string | null
}

const KEY_PREFIX = 'ak_'
const MIN_KEY_LENGTH = 20

function isValidKeyFormat(rawKey: string): boolean {
  return rawKey.startsWith(KEY_PREFIX) && rawKey.length >= MIN_KEY_LENGTH
}

export async function verifyApiKey(db: D1Database, rawKey: string): Promise<ApiKeyRecord | null> {
  if (!isValidKeyFormat(rawKey)) {
    return null
  }

  const keyHash = await sha256Hex(rawKey)

  const row = await db
    .prepare('SELECT key_id, key_prefix, owner_label, revoked_at FROM parseotter_api_keys WHERE key_hash = ?')
    .bind(keyHash)
    .first<ApiKeyRow>()

  if (!row || row.revoked_at !== null) {
    return null
  }

  // Fire-and-forget: update last_used_at without blocking the main flow
  void db
    .prepare("UPDATE parseotter_api_keys SET last_used_at = datetime('now') WHERE key_id = ?")
    .bind(row.key_id)
    .run()

  return {
    keyId: row.key_id,
    keyPrefix: row.key_prefix,
    ownerLabel: row.owner_label,
    revokedAt: row.revoked_at,
  }
}
