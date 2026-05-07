import type { ActiveUploadView, QueuedUploadView } from './upload-queue'
import type { RestoredTaskView } from './task-view-mapping'

type SelectedFileStatus = 'ready' | 'duplicate' | 'invalid'

export type SelectedFileView = {
  localId: string
  file: File
  fileName: string
  fileSizeBytes: number
  status: SelectedFileStatus
  message: string | null
  duplicateTaskId: string | null
}

type DuplicateFileMatch = {
  taskId: string | null
  message: string
}

export function createFileIdentity(input: { fileName: string; fileSizeBytes: number }): string {
  return `${input.fileName}\u0000${input.fileSizeBytes}`
}

function hasNotExpired(task: RestoredTaskView, now: Date): boolean {
  return Number.isFinite(Date.parse(task.expiresAt)) && Date.parse(task.expiresAt) > now.getTime()
}

function isDuplicateBlockingTask(task: RestoredTaskView, now: Date): boolean {
  return hasNotExpired(task, now) && task.status !== 'failed' && task.status !== 'expired'
}

function findDuplicateFileTask(file: File, tasks: RestoredTaskView[], now = new Date()): RestoredTaskView | null {
  return (
    tasks.find(
      (task) =>
        isDuplicateBlockingTask(task, now) &&
        task.fileName === file.name &&
        task.fileSizeBytes !== null &&
        task.fileSizeBytes === file.size
    ) ?? null
  )
}

function matchesFileIdentity(
  input: { fileName: string; fileSizeBytes: number | null },
  file: Pick<File, 'name' | 'size'>
): boolean {
  return input.fileSizeBytes !== null && input.fileName === file.name && input.fileSizeBytes === file.size
}

function getDuplicateFileMessage(task: RestoredTaskView): string {
  if (task.status === 'succeeded') {
    return 'Converted result already exists.'
  }

  if (task.status === 'processing' || task.status === 'dispatch_pending' || task.status === 'dispatching' || task.status === 'restoring') {
    return 'Already processing'
  }

  if (task.status === 'upload_pending' || task.status === 'uploading' || task.status === 'created') {
    return 'Already uploading'
  }

  return 'This file already exists in Files.'
}

export function findDuplicateFileMatch(
  file: File,
  input: {
    queuedUploads: QueuedUploadView[]
    activeUploads: ActiveUploadView[]
    restoredTasks: RestoredTaskView[]
    now?: Date
  }
): DuplicateFileMatch | null {
  const queuedUpload = input.queuedUploads.find((upload) =>
    matchesFileIdentity(
      {
        fileName: upload.fileName,
        fileSizeBytes: upload.fileSizeBytes,
      },
      file
    )
  )

  if (queuedUpload) {
    return {
      taskId: null,
      message: 'Already uploading',
    }
  }

  const activeUpload = input.activeUploads.find((upload) =>
    matchesFileIdentity(
      {
        fileName: upload.fileName,
        fileSizeBytes: upload.fileSizeBytes,
      },
      file
    )
  )

  if (activeUpload) {
    return {
      taskId: activeUpload.taskId,
      message: 'Already uploading',
    }
  }

  const duplicateTask = findDuplicateFileTask(file, input.restoredTasks, input.now)
  if (!duplicateTask) {
    return null
  }

  return {
    taskId: duplicateTask.taskId,
    message: getDuplicateFileMessage(duplicateTask),
  }
}
