import type { UploadProgress } from './multipart-uploader'
import type { RestoredTaskView } from './task-view-mapping'

export const FILE_UPLOAD_CONCURRENCY_LIMIT = 2
export const FREE_HOSTED_LIMIT_MESSAGE = 'Free hosted limit used. Self-host to continue today.'

const FREE_HOSTED_LIMIT_ERROR_CODES = new Set([
  'CLIENT_DAILY_DISPATCH_LIMIT_EXCEEDED',
  'CLIENT_DAILY_UPLOAD_BYTES_LIMIT_EXCEEDED',
])

type FailedUploadView = Pick<ActiveUploadView, 'localId' | 'taskId' | 'fileName' | 'fileSizeBytes'> &
  Partial<Pick<ActiveUploadView, 'fileType'>>

export type QueuedUploadView = {
  localId: string
  file: File
  fileName: string
  fileType: string
  fileSizeBytes: number
  phase: 'waiting'
  message: 'Waiting to upload'
}

type ActiveUploadPhase = 'creating_task' | 'preparing' | 'uploading'

export type ActiveUploadView = {
  localId: string
  taskId: string | null
  fileName: string
  fileType: string
  fileSizeBytes: number
  phase: ActiveUploadPhase
  status: string
  progress: number
  uploadedBytes: number
  totalBytes: number
  bytesPerSecond: number | null
  errorMessage: string | null
  canCancel: boolean
}

export function uploadStatusFromProgress(progress: UploadProgress): string {
  return `Uploading ${progress.percent}%`
}

export function createQueuedUploadView(file: {
  localId: string
  file: File
  fileName: string
  fileType?: string
  fileSizeBytes: number
}): QueuedUploadView {
  return {
    localId: file.localId,
    file: file.file,
    fileName: file.fileName,
    fileType: file.fileType ?? file.file.type,
    fileSizeBytes: file.fileSizeBytes,
    phase: 'waiting',
    message: 'Waiting to upload',
  }
}

export function createActiveUploadView(upload: QueuedUploadView): ActiveUploadView {
  return {
    localId: upload.localId,
    taskId: null,
    fileName: upload.fileName,
    fileType: upload.fileType,
    fileSizeBytes: upload.fileSizeBytes,
    phase: 'creating_task',
    status: 'Creating task',
    progress: 0,
    uploadedBytes: 0,
    totalBytes: upload.fileSizeBytes,
    bytesPerSecond: null,
    errorMessage: null,
    canCancel: true,
  }
}

export function isUploadAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function isFreeHostedLimitErrorCode(errorCode: string | null | undefined): boolean {
  return typeof errorCode === 'string' && FREE_HOSTED_LIMIT_ERROR_CODES.has(errorCode)
}

export function createFailedUploadTaskView(input: {
  upload: FailedUploadView
  errorCode?: string | null
  errorMessage: string
}): RestoredTaskView {
  const timestamp = new Date().toISOString()
  const errorCode = input.errorCode ?? 'UPLOAD_FAILED'
  const isFreeHostedLimit = isFreeHostedLimitErrorCode(errorCode)

  return {
    taskId: input.upload.taskId ?? `failed-upload:${input.upload.localId}`,
    fileName: input.upload.fileName,
    fileType: input.upload.fileType ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    fileSizeBytes: input.upload.fileSizeBytes,
    outputSizeBytes: null,
    dispatchStartedAt: null,
    dispatchCompletedAt: null,
    status: 'failed',
    visibleStatus: isFreeHostedLimit ? 'Free limit reached' : 'Upload failed',
    errorCode,
    errorMessage: isFreeHostedLimit ? FREE_HOSTED_LIMIT_MESSAGE : input.errorMessage,
    refreshErrorMessage: null,
    canDownload: false,
    isDownloading: false,
  }
}
