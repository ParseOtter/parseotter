export const TASK_ID_PREFIX = 'task_'
export const TASK_ID_RANDOM_BYTES = 24

const TASK_ID_PATTERN = /^task_[A-Za-z0-9_-]{32,}$/

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function createTaskId(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(TASK_ID_RANDOM_BYTES))

  return `${TASK_ID_PREFIX}${base64UrlEncode(randomBytes)}`
}

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId)
}
