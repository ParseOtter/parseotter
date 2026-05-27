#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { randomBytes, createHash } from 'node:crypto'

const KEY_ID_PREFIX = 'ak_'
const RAW_KEY_PREFIX = 'ak_'
const KEY_ID_RANDOM_BYTES = 16
const RAW_KEY_RANDOM_BYTES = 32

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

// Escape a value for embedding in a SQL string literal (SQLite: double single-quotes)
function sqlEscape(value) {
  return value.replace(/'/g, "''")
}

function createKey(label) {
  const keyId = KEY_ID_PREFIX + randomBytes(KEY_ID_RANDOM_BYTES).toString('hex')
  const rawKey = RAW_KEY_PREFIX + randomBytes(RAW_KEY_RANDOM_BYTES).toString('base64url')
  const keyHash = sha256Hex(rawKey)
  const keyPrefix = rawKey.slice(0, 8)

  const labelSql = label ? `'${sqlEscape(label)}'` : 'NULL'
  const sql = `INSERT INTO parseotter_api_keys (key_id, key_hash, key_prefix, owner_label)\nVALUES ('${sqlEscape(keyId)}', '${sqlEscape(keyHash)}', '${sqlEscape(keyPrefix)}', ${labelSql});`

  console.log('=== API Key Created ===')
  console.log()
  console.log('Raw key (show once, cannot be retrieved later):')
  console.log(`  ${rawKey}`)
  console.log()
  console.log('Key ID:')
  console.log(`  ${keyId}`)
  console.log()
  if (label) {
    console.log(`Label: ${label}`)
    console.log()
  }
  console.log('Run this SQL against your D1 database to register the key:')
  console.log()
  console.log(sql)
}

function listKeys() {
  const sql = `SELECT key_id, key_prefix, owner_label, created_at,\n  CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status\nFROM parseotter_api_keys\nORDER BY created_at DESC;`

  console.log('Run this SQL against your D1 database to list all keys:')
  console.log()
  console.log(sql)
}

function revokeKey(keyId) {
  if (!keyId) {
    console.error('Error: key_id is required')
    console.error('Usage: node api-key.mjs revoke <key_id>')
    process.exit(1)
  }

  const sql = `UPDATE parseotter_api_keys\nSET revoked_at = datetime('now')\nWHERE key_id = '${sqlEscape(keyId)}';`

  console.log('Run this SQL against your D1 database to revoke the key:')
  console.log()
  console.log(sql)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: 'string', short: 'l' },
  },
})

const command = positionals[0]

switch (command) {
  case 'create':
    createKey(values.label ?? null)
    break
  case 'list':
    listKeys()
    break
  case 'revoke':
    revokeKey(positionals[1])
    break
  default:
    console.error('Usage: node api-key.mjs <command> [options]')
    console.error()
    console.error('Commands:')
    console.error('  create --label "my app"   Generate a new API key')
    console.error('  list                      Show SQL to list all keys')
    console.error('  revoke <key_id>           Show SQL to revoke a key')
    process.exit(1)
}
