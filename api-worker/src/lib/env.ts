export type EnvSource = Partial<CloudflareBindings> & Record<string, unknown>

export function readStringEnv(env: Partial<CloudflareBindings> | undefined, key: string): string | null {
  const value = (env as EnvSource | undefined)?.[key]

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function readBooleanEnv(env: Partial<CloudflareBindings> | undefined, key: string, fallback: boolean): boolean {
  const value = readStringEnv(env, key)
  if (value === null) {
    return fallback
  }

  if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) {
    return true
  }

  if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) {
    return false
  }

  return fallback
}

export function readNonNegativeIntegerEnv(
  env: Partial<CloudflareBindings> | undefined,
  key: string,
  fallback: number
): number {
  const value = readStringEnv(env, key)
  if (value === null) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function readPositiveIntegerEnv(
  env: Partial<CloudflareBindings> | undefined,
  key: string,
  fallback: number
): number {
  const value = readStringEnv(env, key)
  if (value === null) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function splitCsv(value: string | null | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
