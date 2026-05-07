export const PARSEOTTER_TASKS_STORAGE_KEY = 'parseotter.tasks.v1'
const MAX_STORED_TASKS = 100

export type StoredTask = {
  taskId: string
  fileName: string
  fileType?: string
  createdAt?: string
  updatedAt?: string
  expiresAt: string
  fileSizeBytes?: number
  outputSizeBytes?: number
  dispatchStartedAt?: string
  dispatchCompletedAt?: string
}

function isValidOptionalIsoDate(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function isValidOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isStoredTask(value: unknown): value is StoredTask {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<StoredTask>
  const fileSizeIsValid =
    candidate.fileSizeBytes === undefined ||
    (typeof candidate.fileSizeBytes === 'number' && Number.isFinite(candidate.fileSizeBytes) && candidate.fileSizeBytes >= 0)
  const outputSizeIsValid =
    candidate.outputSizeBytes === undefined ||
    (typeof candidate.outputSizeBytes === 'number' &&
      Number.isFinite(candidate.outputSizeBytes) &&
      candidate.outputSizeBytes >= 0)

  return (
    typeof candidate.taskId === 'string' &&
    typeof candidate.fileName === 'string' &&
    isValidOptionalString(candidate.fileType) &&
    typeof candidate.expiresAt === 'string' &&
    Number.isFinite(Date.parse(candidate.expiresAt)) &&
    isValidOptionalIsoDate(candidate.createdAt) &&
    isValidOptionalIsoDate(candidate.updatedAt) &&
    isValidOptionalIsoDate(candidate.dispatchStartedAt) &&
    isValidOptionalIsoDate(candidate.dispatchCompletedAt) &&
    fileSizeIsValid &&
    outputSizeIsValid
  )
}

function readRawStoredTasks(): StoredTask[] {
  let rawValue: string | null
  try {
    rawValue = window.localStorage.getItem(PARSEOTTER_TASKS_STORAGE_KEY)
  } catch {
    return []
  }

  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown
    return Array.isArray(parsed) ? parsed.filter(isStoredTask) : []
  } catch {
    return []
  }
}

function removeExpiredTasks(tasks: StoredTask[], now: Date): StoredTask[] {
  return tasks.filter((task) => Date.parse(task.expiresAt) > now.getTime())
}

function writeStoredTasks(tasks: StoredTask[]): void {
  try {
    window.localStorage.setItem(PARSEOTTER_TASKS_STORAGE_KEY, JSON.stringify(tasks))
  } catch {
    // Local history is best-effort; conversion should continue if storage is blocked or full.
  }
}

export function loadStoredTasks(input?: { now?: Date }): StoredTask[] {
  const now = input?.now ?? new Date()
  const tasks = removeExpiredTasks(readRawStoredTasks(), now)
  writeStoredTasks(tasks)
  return tasks
}

export function saveStoredTask(task: StoredTask): StoredTask[] {
  const remainingTasks = loadStoredTasks().filter((storedTask) => storedTask.taskId !== task.taskId)
  const nextTasks = [task, ...remainingTasks].slice(0, MAX_STORED_TASKS)
  writeStoredTasks(nextTasks)
  return nextTasks
}

export function removeStoredTask(taskId: string): StoredTask[] {
  const nextTasks = loadStoredTasks().filter((storedTask) => storedTask.taskId !== taskId)
  writeStoredTasks(nextTasks)
  return nextTasks
}
