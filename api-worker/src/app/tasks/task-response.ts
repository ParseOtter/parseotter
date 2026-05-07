import type { TaskSnapshot } from './task-status'

export type TaskResponse = {
  taskId: string
  status: TaskSnapshot['status']
  visibleStatus: TaskSnapshot['visibleStatus']
  version: number
  attempt: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  expiredAt: string | null
  error: {
    code: string
    message: string | null
  } | null
  file: {
    name: string
    type: string
    sizeBytes: number
  }
  upload: {
    uploadId: string | null
    status: string | null
    inputSizeBytes: number | null
    inputEtag: string | null
    inputContentType: string | null
    inputPartCount: number | null
    inputChecksumSha256: string | null
  }
  output: {
    contentType: string | null
    sizeBytes: number | null
  }
  dispatch: {
    status: string | null
    attempt: number
    startedAt: string | null
    completedAt: string | null
  }
}

export function serializeTaskResponse(snapshot: TaskSnapshot): TaskResponse {
  return {
    taskId: snapshot.taskId,
    status: snapshot.status,
    visibleStatus: snapshot.visibleStatus,
    version: snapshot.version,
    attempt: snapshot.attempt,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    expiresAt: snapshot.expiresAt,
    expiredAt: snapshot.expiredAt,
    error: snapshot.errorCode
      ? {
          code: snapshot.errorCode,
          message: snapshot.errorMessage,
        }
      : null,
    file: {
      name: snapshot.fileName,
      type: snapshot.fileType,
      sizeBytes: snapshot.fileSizeBytes,
    },
    upload: {
      uploadId: snapshot.uploadId,
      status: snapshot.uploadStatus,
      inputSizeBytes: snapshot.inputSizeBytes,
      inputEtag: snapshot.inputEtag,
      inputContentType: snapshot.inputContentType,
      inputPartCount: snapshot.inputPartCount,
      inputChecksumSha256: snapshot.inputChecksumSha256,
    },
    output: {
      contentType: snapshot.outputContentType,
      sizeBytes: snapshot.outputSizeBytes,
    },
    dispatch: {
      status: snapshot.dispatchStatus,
      attempt: snapshot.dispatchAttempt,
      startedAt: snapshot.dispatchStartedAt,
      completedAt: snapshot.dispatchCompletedAt,
    },
  }
}
