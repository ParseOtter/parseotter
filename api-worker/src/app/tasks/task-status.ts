export const INTERNAL_TASK_STATUSES = [
  'created',
  'upload_pending',
  'uploading',
  'upload_completed',
  'dispatch_pending',
  'dispatching',
  'processing',
  'succeeded',
  'failed',
  'expired',
] as const

export type InternalTaskStatus = (typeof INTERNAL_TASK_STATUSES)[number]

export type VisibleTaskStatus =
  | 'Waiting for upload'
  | 'Uploading'
  | 'Upload complete'
  | 'Waiting for conversion'
  | 'Converting'
  | 'Conversion complete'
  | 'Conversion failed'
  | 'Expired'

export type TaskErrorCode =
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'UPLOAD_FAILED'
  | 'UPLOAD_NOT_COMPLETE'
  | 'UPLOAD_ABORTED'
  | 'UPLOAD_PART_INVALID'
  | 'TASK_NOT_FOUND'
  | 'TASK_EXPIRED'
  | 'PROCESSING_TIMEOUT'
  | 'MODAL_DISPATCH_FAILED'
  | 'MODAL_PROCESSING_FAILED'
  | 'CALLBACK_UNAUTHORIZED'
  | 'RESULT_NOT_READY'
  | 'RESULT_NOT_FOUND'

export type TaskSnapshot = {
  taskId: string
  status: InternalTaskStatus
  visibleStatus: VisibleTaskStatus
  version: number
  attempt: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  expiredAt: string | null
  errorCode: TaskErrorCode | null
  errorMessage: string | null
  fileName: string
  fileType: string
  fileSizeBytes: number
  uploadId: string | null
  uploadStatus: string | null
  inputObjectKey: string | null
  inputSizeBytes: number | null
  inputEtag: string | null
  inputContentType: string | null
  inputPartCount: number | null
  inputChecksumSha256: string | null
  outputObjectKey: string | null
  outputContentType: string | null
  outputSizeBytes: number | null
  dispatchStatus: string | null
  dispatchAttempt: number
  dispatchIdempotencyKey: string | null
  dispatchStartedAt: string | null
  dispatchCompletedAt: string | null
  lastCallbackIdempotencyKey: string | null
  clientHash: string | null
  clientUserAgent: string | null
  clientIpHash: string | null
  gaClientId: string | null
}

export type TaskTransition = {
  status: InternalTaskStatus
  visibleStatus?: VisibleTaskStatus
  attempt?: number
  updatedAt: string
  expiredAt?: string | null
  errorCode?: TaskErrorCode | null
  errorMessage?: string | null
}

export type TaskTransitionResult = {
  applied: boolean
  snapshot: TaskSnapshot
}

const VISIBLE_STATUS_BY_INTERNAL_STATUS: Record<InternalTaskStatus, VisibleTaskStatus> = {
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

const TERMINAL_STATUSES = new Set<InternalTaskStatus>(['succeeded', 'failed', 'expired'])

export function mapInternalStatusToVisibleStatus(status: InternalTaskStatus): VisibleTaskStatus {
  return VISIBLE_STATUS_BY_INTERNAL_STATUS[status]
}

export function isTerminalTaskStatus(status: InternalTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function createFailureTransition(input: {
  attempt?: number
  errorCode: Extract<
    TaskErrorCode,
    'UPLOAD_ABORTED' | 'UPLOAD_FAILED' | 'MODAL_DISPATCH_FAILED' | 'MODAL_PROCESSING_FAILED'
  >
  errorMessage?: string | null
  updatedAt: string
}): TaskTransition {
  return {
    status: 'failed',
    visibleStatus: mapInternalStatusToVisibleStatus('failed'),
    attempt: input.attempt,
    updatedAt: input.updatedAt,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage ?? null,
  }
}

export function createExpiredTransition(input: { updatedAt: string; expiredAt?: string | null }): TaskTransition {
  return {
    status: 'expired',
    visibleStatus: mapInternalStatusToVisibleStatus('expired'),
    updatedAt: input.updatedAt,
    expiredAt: input.expiredAt ?? input.updatedAt,
    errorCode: 'TASK_EXPIRED',
    errorMessage: 'Task has expired',
  }
}

export function applyTaskTransition(snapshot: TaskSnapshot, transition: TaskTransition): TaskTransitionResult {
  const nextAttempt = transition.attempt ?? snapshot.attempt

  if (nextAttempt < snapshot.attempt) {
    return { applied: false, snapshot }
  }

  if (snapshot.status === 'expired') {
    return { applied: false, snapshot }
  }

  if (isTerminalTaskStatus(snapshot.status) && transition.status !== 'expired') {
    return { applied: false, snapshot }
  }

  const nextSnapshot: TaskSnapshot = {
    ...snapshot,
    status: transition.status,
    visibleStatus: transition.visibleStatus ?? mapInternalStatusToVisibleStatus(transition.status),
    version: snapshot.version + 1,
    attempt: nextAttempt,
    updatedAt: transition.updatedAt,
    expiredAt: transition.expiredAt ?? snapshot.expiredAt,
    errorCode: transition.errorCode === undefined ? snapshot.errorCode : transition.errorCode,
    errorMessage: transition.errorMessage === undefined ? snapshot.errorMessage : transition.errorMessage,
  }

  return { applied: true, snapshot: nextSnapshot }
}
