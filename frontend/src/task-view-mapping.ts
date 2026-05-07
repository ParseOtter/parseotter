import { formatBytes, formatTaskDate } from './format'
import type { TaskResponse } from './parseotter-api'
import type { StoredTask } from './task-storage'
import type { ActiveUploadView } from './upload-queue'

export type RestoredTaskView = Omit<
  StoredTask,
  'createdAt' | 'updatedAt' | 'fileType' | 'fileSizeBytes' | 'outputSizeBytes' | 'dispatchStartedAt' | 'dispatchCompletedAt'
> & {
  createdAt: string | null
  updatedAt: string | null
  fileType: string | null
  fileSizeBytes: number | null
  outputSizeBytes: number | null
  dispatchStartedAt: string | null
  dispatchCompletedAt: string | null
  status: string
  visibleStatus: string
  errorCode: string | null
  errorMessage: string | null
  refreshErrorMessage: string | null
  canDownload: boolean
  isDownloading: boolean
}

const TASK_STATUSES_WITH_PERSISTED_UPLOAD = new Set([
  'upload_completed',
  'dispatch_pending',
  'dispatching',
  'processing',
  'succeeded',
  'expired',
])

export const PROCESSING_TASK_STATUSES = new Set(['upload_completed', 'dispatch_pending', 'dispatching', 'processing'])

const DISPLAY_STATUS_BY_TASK_STATUS: Record<string, string> = {
  created: 'Waiting for upload',
  upload_pending: 'Waiting for upload',
  uploading: 'Uploading',
  upload_completed: 'Upload complete',
  dispatch_pending: 'Waiting for conversion',
  dispatching: 'Converting',
  processing: 'Converting',
  succeeded: 'Conversion complete',
  failed: 'Conversion failed',
  expired: 'Expired',
}

function getTaskDisplayStatus(status: string, fallback: string): string {
  return DISPLAY_STATUS_BY_TASK_STATUS[status] ?? fallback
}

function getTaskErrorDisplayMessage(error: TaskResponse['error']): string | null {
  if (!error) {
    return null
  }

  if (error.code === 'TASK_EXPIRED') {
    return 'Task has expired.'
  }

  return error.message
}

export function mapStoredTaskToView(task: StoredTask): RestoredTaskView {
  return {
    ...task,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    fileType: task.fileType ?? null,
    fileSizeBytes: task.fileSizeBytes ?? null,
    outputSizeBytes: task.outputSizeBytes ?? null,
    dispatchStartedAt: task.dispatchStartedAt ?? null,
    dispatchCompletedAt: task.dispatchCompletedAt ?? null,
    status: 'restoring',
    visibleStatus: 'Checking',
    errorCode: null,
    errorMessage: null,
    refreshErrorMessage: null,
    canDownload: false,
    isDownloading: false,
  }
}

export function mapTaskResponseToView(task: TaskResponse): RestoredTaskView {
  return {
    taskId: task.taskId,
    fileName: task.file.name,
    fileType: task.file.type,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    fileSizeBytes: task.file.sizeBytes,
    outputSizeBytes: task.output.sizeBytes,
    dispatchStartedAt: task.dispatch.startedAt,
    dispatchCompletedAt: task.dispatch.completedAt,
    status: task.status,
    visibleStatus: getTaskDisplayStatus(task.status, task.visibleStatus),
    errorCode: task.error?.code ?? null,
    errorMessage: getTaskErrorDisplayMessage(task.error),
    refreshErrorMessage: null,
    canDownload: task.status === 'succeeded',
    isDownloading: false,
  }
}

export function shouldPersistTask(task: Pick<RestoredTaskView, 'status' | 'errorCode'>): boolean {
  if (TASK_STATUSES_WITH_PERSISTED_UPLOAD.has(task.status)) {
    return true
  }

  return task.status === 'failed' && !task.errorCode?.startsWith('UPLOAD')
}

export function mapViewToStoredTask(task: RestoredTaskView): StoredTask {
  return {
    taskId: task.taskId,
    fileName: task.fileName,
    fileType: task.fileType ?? undefined,
    createdAt: task.createdAt ?? undefined,
    updatedAt: task.updatedAt ?? undefined,
    expiresAt: task.expiresAt,
    fileSizeBytes: task.fileSizeBytes ?? undefined,
    outputSizeBytes: task.outputSizeBytes ?? undefined,
    dispatchStartedAt: task.dispatchStartedAt ?? undefined,
    dispatchCompletedAt: task.dispatchCompletedAt ?? undefined,
  }
}

export function isActiveTask(task: RestoredTaskView): boolean {
  return !['succeeded', 'failed', 'expired'].includes(task.status)
}

function getTaskCreatedTimestamp(task: RestoredTaskView): number {
  if (task.createdAt && Number.isFinite(Date.parse(task.createdAt))) {
    return Date.parse(task.createdAt)
  }

  return Number.isFinite(Date.parse(task.expiresAt)) ? Date.parse(task.expiresAt) : 0
}

export function sortTasksByUploadTime(tasks: RestoredTaskView[]): RestoredTaskView[] {
  return [...tasks].sort((left, right) => {
    const timeDifference = getTaskCreatedTimestamp(right) - getTaskCreatedTimestamp(left)
    return timeDifference === 0 ? left.taskId.localeCompare(right.taskId) : timeDifference
  })
}

export function updateTaskList(tasks: RestoredTaskView[], nextTask: RestoredTaskView): RestoredTaskView[] {
  const remainingTasks = tasks.filter((task) => task.taskId !== nextTask.taskId)
  return sortTasksByUploadTime([nextTask, ...remainingTasks])
}

export function mergeTaskViews(primaryTasks: RestoredTaskView[], fallbackTasks: RestoredTaskView[]): RestoredTaskView[] {
  const primaryTaskIds = new Set(primaryTasks.map((task) => task.taskId))
  return [...primaryTasks, ...fallbackTasks.filter((task) => !primaryTaskIds.has(task.taskId))]
}

function getTaskUploadCompletedAt(task: RestoredTaskView): string | null {
  if (task.errorCode?.startsWith('UPLOAD')) {
    return null
  }

  if (!PROCESSING_TASK_STATUSES.has(task.status) && task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'expired') {
    return null
  }

  return task.dispatchStartedAt ?? task.updatedAt
}

export function formatTaskUploadMeta(task: RestoredTaskView): string {
  const size = task.fileSizeBytes === null ? 'size pending' : formatBytes(task.fileSizeBytes)
  const completedAt = getTaskUploadCompletedAt(task)

  if (!completedAt) {
    return `Upload ${size} · ${task.visibleStatus}`
  }

  return `Uploaded ${size} · ${formatTaskDate(completedAt)}`
}

export function formatCompletedTaskResultMeta(task: RestoredTaskView): string {
  const size = task.outputSizeBytes === null ? 'size pending' : formatBytes(task.outputSizeBytes)
  return `Result ${size} · ${formatTaskDate(task.dispatchCompletedAt ?? task.updatedAt)}`
}

export function formatActiveUploadMeta(upload: ActiveUploadView): string {
  if (upload.phase === 'creating_task') {
    return `${formatBytes(upload.fileSizeBytes)} · ${upload.status}`
  }

  if (upload.phase === 'preparing') {
    return `${formatBytes(upload.fileSizeBytes)} · Preparing upload`
  }

  return `${formatBytes(upload.uploadedBytes)} of ${formatBytes(upload.totalBytes)} uploaded`
}
