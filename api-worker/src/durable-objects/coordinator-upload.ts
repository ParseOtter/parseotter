import { sendGa4TaskEvent } from '../app/analytics/ga4'
import {
  assertCompleteUploadAllowed,
  assertUploadSessionAllowed,
  incrementUploadCompletedUsage,
  insertClientActionEvent,
} from '../app/abuse/usage'
import { AppHttpError } from '../app/http/errors'
import { readJsonObject } from '../app/http/json-body'
import { REQUEST_ID_HEADER } from '../app/http/request-id'
import { jsonSuccess } from '../app/http/responses'
import { markTaskDispatchPending } from '../app/tasks/dispatch-outbox'
import { isUploadedFileAuthentic } from '../app/tasks/file-authenticity'
import { dispatchModalForPendingTask } from '../app/tasks/modal-dispatch'
import {
  createCompletedUploadParts,
  createUploadSessionResponse,
  parseCompleteUploadRequest,
  parseSignedUploadPartsRequest,
} from '../app/tasks/multipart-plan'
import { createSignedUploadPartsResponse } from '../app/tasks/r2-presigner'
import {
  getAccessibleTaskSnapshot,
  persistAbortedTaskUpload,
  persistCompletedTaskUpload,
  persistFailedTaskUpload,
  persistTaskUploadSession,
} from '../app/tasks/task-record'
import type { TaskSnapshot } from '../app/tasks/task-status'
import { createInputObjectKey } from '../app/tasks/upload-validation'
import { createTaskSnapshotResponse } from './coordinator-task-lifecycle'
import { createTaskNotFoundError } from './coordinator-routing'

function createTaskExpiredError(): AppHttpError {
  return new AppHttpError({
    status: 410,
    code: 'TASK_EXPIRED',
    message: 'Task has expired',
  })
}

function createInvalidUploadSessionError(): AppHttpError {
  return new AppHttpError({
    status: 400,
    code: 'UPLOAD_PART_INVALID',
    message: 'Upload session is invalid for this task',
  })
}

function createUploadNotPendingError(): AppHttpError {
  return new AppHttpError({
    status: 409,
    code: 'UPLOAD_NOT_COMPLETE',
    message: 'Upload is not pending',
  })
}

function createInvalidCompletedPartsError(): AppHttpError {
  return new AppHttpError({
    status: 400,
    code: 'UPLOAD_PART_INVALID',
    message: 'Completed parts manifest is invalid for this upload',
  })
}

function createUploadSessionConflictError(): AppHttpError {
  return new AppHttpError({
    status: 409,
    code: 'CONFLICT',
    message: 'Upload session cannot be created in the current task state',
  })
}

function isAbortedUploadSnapshot(snapshot: TaskSnapshot): boolean {
  return snapshot.uploadStatus === 'aborted' && snapshot.errorCode === 'UPLOAD_ABORTED'
}

function hasUploadSession(snapshot: TaskSnapshot | null): snapshot is TaskSnapshot & {
  uploadId: string
  uploadStatus: string
} {
  return Boolean(snapshot?.uploadId && snapshot.uploadStatus)
}

function assertUploadSessionMatches(snapshot: TaskSnapshot, uploadId: string): asserts snapshot is TaskSnapshot & {
  uploadId: string
  inputObjectKey: string
} {
  if (snapshot.uploadId !== uploadId || snapshot.inputObjectKey === null) {
    throw createInvalidUploadSessionError()
  }
}

function createUploadSessionHttpResponse(
  env: CloudflareBindings,
  snapshot: TaskSnapshot & { uploadId: string; uploadStatus: string },
  status: number,
  requestId: string
): Response {
  return jsonSuccess(
    createUploadSessionResponse({
      taskId: snapshot.taskId,
      uploadId: snapshot.uploadId,
      status: snapshot.uploadStatus,
      fileSizeBytes: snapshot.fileSizeBytes,
      env,
    }),
    {
      status,
      requestId,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
      },
    }
  )
}

async function ensureDispatchPendingForCompletedUpload(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  request: Request
): Promise<TaskSnapshot> {
  if (snapshot.uploadStatus !== 'completed') {
    return snapshot
  }

  const dispatchPending = await markTaskDispatchPending(env.DB, snapshot.taskId)
  return dispatchPendingSnapshot(env, dispatchPending.snapshot ?? snapshot, request)
}

async function dispatchPendingSnapshot(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  request: Request
): Promise<TaskSnapshot> {
  if (snapshot.status !== 'dispatch_pending' || snapshot.dispatchStatus !== 'pending') {
    return snapshot
  }

  const dispatched = await dispatchModalForPendingTask({
    db: env.DB,
    env,
    taskId: snapshot.taskId,
    callbackOrigin: request.headers.get('x-backend-origin'),
  })

  return dispatched ?? snapshot
}

async function persistUploadFailed(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  errorMessage: string
): Promise<TaskSnapshot> {
  let currentSnapshot = snapshot

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const persistedFailure = await persistFailedTaskUpload(env.DB, {
      snapshot: currentSnapshot,
      errorCode: 'UPLOAD_FAILED',
      errorMessage,
      uploadStatus: 'failed',
    })
    const failedSnapshot = persistedFailure.snapshot

    if (!failedSnapshot) {
      throw createTaskNotFoundError()
    }

    if (failedSnapshot.uploadStatus === 'failed' && failedSnapshot.errorCode === 'UPLOAD_FAILED') {
      return failedSnapshot
    }

    if (isAbortedUploadSnapshot(failedSnapshot)) {
      currentSnapshot = failedSnapshot
      continue
    }

    return failedSnapshot
  }

  return currentSnapshot
}

async function persistUploadFailedForInvalidContent(
  env: CloudflareBindings,
  snapshot: TaskSnapshot
): Promise<TaskSnapshot> {
  return persistUploadFailed(env, snapshot, 'Uploaded file content does not match the declared file type')
}

async function persistUploadFailedForSizeMismatch(
  env: CloudflareBindings,
  snapshot: TaskSnapshot
): Promise<TaskSnapshot> {
  return persistUploadFailed(env, snapshot, 'Uploaded object size does not match the declared file size')
}

async function persistCompletedUploadAndDispatch(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  object: R2Object,
  request: Request
): Promise<TaskSnapshot> {
  let currentSnapshot = snapshot

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const persistedCompletion = await persistCompletedTaskUpload(env.DB, {
      snapshot: currentSnapshot,
      object,
    })
    const completedSnapshot = persistedCompletion.snapshot

    if (!completedSnapshot) {
      throw createTaskNotFoundError()
    }

    if (completedSnapshot.uploadStatus === 'completed') {
      if (persistedCompletion.persisted && completedSnapshot.clientHash && completedSnapshot.inputSizeBytes !== null) {
        await incrementUploadCompletedUsage(env.DB, {
          clientHash: completedSnapshot.clientHash,
          bytes: completedSnapshot.inputSizeBytes,
          taskId: completedSnapshot.taskId,
        })
      }
      if (persistedCompletion.persisted) {
        await sendGa4TaskEvent({
          env,
          snapshot: completedSnapshot,
          name: 'parseotter_upload_completed',
        })
      }

      return ensureDispatchPendingForCompletedUpload(env, completedSnapshot, request)
    }

    if (isAbortedUploadSnapshot(completedSnapshot)) {
      currentSnapshot = completedSnapshot
      continue
    }

    return completedSnapshot
  }

  return currentSnapshot
}

async function finalizeRecoveredUploadFromObject(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  object: R2Object,
  request: Request
): Promise<TaskSnapshot> {
  if (object.size !== snapshot.fileSizeBytes) {
    return persistUploadFailedForSizeMismatch(env, snapshot)
  }

  const isAuthentic = await isUploadedFileAuthentic({
    bucket: env.R2_BUCKET,
    objectKey: object.key,
    fileType: snapshot.fileType,
  })

  if (!isAuthentic) {
    return persistUploadFailedForInvalidContent(env, snapshot)
  }

  return persistCompletedUploadAndDispatch(env, snapshot, object, request)
}

async function recoverCompletedUploadIfObjectExists(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  request: Request
): Promise<TaskSnapshot | null> {
  if (snapshot.inputObjectKey === null) {
    return null
  }

  const object = await env.R2_BUCKET.head(snapshot.inputObjectKey)
  if (!object) {
    return null
  }

  return finalizeRecoveredUploadFromObject(env, snapshot, object, request)
}

async function completePendingUpload(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  uploadId: string,
  snapshot: TaskSnapshot & { inputObjectKey: string }
): Promise<TaskSnapshot> {
  const payload = await readJsonObject(request)
  const completeRequest = parseCompleteUploadRequest(payload)
  const uploadedParts = createCompletedUploadParts({
    parts: completeRequest.parts,
    fileSizeBytes: snapshot.fileSizeBytes,
  })
  const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(snapshot.inputObjectKey, uploadId)

  try {
    await multipartUpload.complete(uploadedParts)
  } catch {
    const recoveredSnapshot = await recoverCompletedUploadIfObjectExists(
      env,
      await getAccessibleTaskSnapshot(env.DB, taskId),
      request
    )
    if (recoveredSnapshot) {
      return recoveredSnapshot
    }

    throw createInvalidCompletedPartsError()
  }

  const object = await env.R2_BUCKET.head(snapshot.inputObjectKey)
  if (!object) {
    throw new AppHttpError({
      status: 500,
      code: 'UPLOAD_FAILED',
      message: 'Uploaded object could not be verified',
    })
  }

  return finalizeRecoveredUploadFromObject(env, snapshot, object, request)
}

async function recoverNonPendingUpload(
  env: CloudflareBindings,
  snapshot: TaskSnapshot,
  request: Request
): Promise<TaskSnapshot> {
  const recoveredSnapshot = await recoverCompletedUploadIfObjectExists(env, snapshot, request)
  if (recoveredSnapshot) {
    return recoveredSnapshot
  }

  throw createUploadNotPendingError()
}

async function abortPendingUpload(
  env: CloudflareBindings,
  taskId: string,
  uploadId: string,
  snapshot: TaskSnapshot & { inputObjectKey: string },
  request: Request
): Promise<TaskSnapshot> {
  try {
    await env.R2_BUCKET.resumeMultipartUpload(snapshot.inputObjectKey, uploadId).abort()
  } catch {
    const recoveredSnapshot = await recoverCompletedUploadIfObjectExists(
      env,
      await getAccessibleTaskSnapshot(env.DB, taskId),
      request
    )
    if (recoveredSnapshot) {
      return recoveredSnapshot
    }

    // Abort is best-effort cleanup; the task should still transition to a failed terminal state.
  }

  const persistedAbort = await persistAbortedTaskUpload(env.DB, {
    snapshot,
  })
  const abortedSnapshot = persistedAbort.snapshot

  if (!abortedSnapshot) {
    throw createTaskNotFoundError()
  }

  return abortedSnapshot
}

async function handleLostUploadSessionRace(
  multipartUpload: R2MultipartUpload,
  updatedSnapshot: TaskSnapshot | null
): Promise<void> {
  try {
    await multipartUpload.abort()
  } catch {
    // Best-effort cleanup for a raced multipart upload that lost the conditional D1 write.
  }

  if (!updatedSnapshot) {
    throw createTaskNotFoundError()
  }

  if (updatedSnapshot.status === 'expired') {
    throw createTaskExpiredError()
  }
}

export async function createUploadSession(
  env: CloudflareBindings,
  taskId: string,
  requestId: string
): Promise<Response> {
  const snapshot = await getAccessibleTaskSnapshot(env.DB, taskId)

  if (hasUploadSession(snapshot) && snapshot.uploadStatus === 'pending') {
    return createUploadSessionHttpResponse(env, snapshot, 200, requestId)
  }

  if (snapshot.status !== 'created' && snapshot.status !== 'upload_pending') {
    throw createUploadSessionConflictError()
  }

  if (snapshot.clientHash) {
    await assertUploadSessionAllowed({
      db: env.DB,
      env,
      clientHash: snapshot.clientHash,
      taskId: snapshot.taskId,
      requestId,
    })
  }

  const inputObjectKey = createInputObjectKey(snapshot.taskId, snapshot.fileType)
  const multipartUpload = await env.R2_BUCKET.createMultipartUpload(inputObjectKey, {
    httpMetadata: {
      contentType: snapshot.fileType,
    },
  })
  const persistedUploadSession = await persistTaskUploadSession(env.DB, {
    snapshot,
    uploadId: multipartUpload.uploadId,
    inputObjectKey,
  })
  const updatedSnapshot = persistedUploadSession.snapshot
  const sessionWasPersisted = persistedUploadSession.persisted

  if (!sessionWasPersisted) {
    await handleLostUploadSessionRace(multipartUpload, updatedSnapshot)
  }

  if (!hasUploadSession(updatedSnapshot)) {
    throw createUploadSessionConflictError()
  }

  if (sessionWasPersisted && updatedSnapshot.clientHash) {
    await insertClientActionEvent(env.DB, {
      clientHash: updatedSnapshot.clientHash,
      route: 'upload_session',
      taskId: updatedSnapshot.taskId,
    })
  }

  return createUploadSessionHttpResponse(env, updatedSnapshot, sessionWasPersisted ? 201 : 200, requestId)
}

export async function signUploadParts(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  uploadId: string,
  requestId: string
): Promise<Response> {
  const snapshot = await getAccessibleTaskSnapshot(env.DB, taskId)
  assertUploadSessionMatches(snapshot, uploadId)

  if (snapshot.uploadStatus !== 'pending') {
    throw createInvalidUploadSessionError()
  }

  const payload = await readJsonObject(request)
  const signRequest = parseSignedUploadPartsRequest(payload)
  const response = await createSignedUploadPartsResponse({
    taskId: snapshot.taskId,
    uploadId: snapshot.uploadId,
    inputObjectKey: snapshot.inputObjectKey,
    fileSizeBytes: snapshot.fileSizeBytes,
    partNumbers: signRequest.partNumbers,
    env,
  })

  return jsonSuccess(response, {
    requestId,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
    },
  })
}

export async function completeUpload(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  uploadId: string,
  requestId: string
): Promise<Response> {
  const snapshot = await getAccessibleTaskSnapshot(env.DB, taskId)
  assertUploadSessionMatches(snapshot, uploadId)
  let completedSnapshot: TaskSnapshot

  if (snapshot.uploadStatus === 'completed') {
    completedSnapshot = await ensureDispatchPendingForCompletedUpload(env, snapshot, request)
  } else if (snapshot.uploadStatus !== 'pending') {
    completedSnapshot = await recoverNonPendingUpload(env, snapshot, request)
  } else {
    if (snapshot.clientHash) {
      await assertCompleteUploadAllowed({
        db: env.DB,
        env,
        clientHash: snapshot.clientHash,
        taskId: snapshot.taskId,
        fileSizeBytes: snapshot.fileSizeBytes,
        requestId,
      })
    }
    completedSnapshot = await completePendingUpload(env, request, taskId, uploadId, snapshot)
  }

  return createTaskSnapshotResponse(completedSnapshot, requestId)
}

export async function abortUpload(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  uploadId: string,
  requestId: string
): Promise<Response> {
  const snapshot = await getAccessibleTaskSnapshot(env.DB, taskId)
  assertUploadSessionMatches(snapshot, uploadId)

  if (snapshot.uploadStatus === 'completed') {
    return createTaskSnapshotResponse(
      await ensureDispatchPendingForCompletedUpload(
        env,
        snapshot,
        request
      ),
      requestId
    )
  }

  if (snapshot.status === 'failed' && isAbortedUploadSnapshot(snapshot)) {
    return createTaskSnapshotResponse(snapshot, requestId)
  }

  if (snapshot.uploadStatus !== 'pending') {
    return createTaskSnapshotResponse(
      await recoverNonPendingUpload(
        env,
        snapshot,
        request
      ),
      requestId
    )
  }

  return createTaskSnapshotResponse(await abortPendingUpload(env, taskId, uploadId, snapshot, request), requestId)
}
