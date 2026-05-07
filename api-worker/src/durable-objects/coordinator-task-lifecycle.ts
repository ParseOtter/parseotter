import { sendGa4TaskEvent } from '../app/analytics/ga4'
import { isClientHash } from '../app/abuse/client-identity'
import {
  assertDownloadAllowed,
  incrementTaskCreatedUsage,
  insertClientActionEvent,
} from '../app/abuse/usage'
import { createDownloadResultResponse } from '../app/tasks/download-result'
import { reconcileTaskSnapshot } from '../app/tasks/task-reconciliation'
import {
  createInitialTaskSnapshot,
  getAccessibleTaskSnapshot,
  insertTaskSnapshot,
} from '../app/tasks/task-record'
import { serializeTaskResponse } from '../app/tasks/task-response'
import type { TaskSnapshot } from '../app/tasks/task-status'
import { parseCreateTaskRequest } from '../app/tasks/task-validation'
import { readJsonObject } from '../app/http/json-body'
import { REQUEST_ID_HEADER } from '../app/http/request-id'
import { jsonSuccess } from '../app/http/responses'
import { createTaskNotFoundError } from './coordinator-routing'

function readClientHashHeader(request: Request): string | null {
  const value = request.headers.get('x-client-hash')
  return isClientHash(value) ? value : null
}

function readInternalNullableString(payload: Record<string, unknown>, fieldName: string): string | null {
  const value = payload[fieldName]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function createTaskSnapshotResponse(snapshot: TaskSnapshot, requestId: string): Response {
  return jsonSuccess(serializeTaskResponse(snapshot), {
    requestId,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
    },
  })
}

export async function createTask(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  requestId: string
): Promise<Response> {
  const payload = await readJsonObject(request)
  const createInput = parseCreateTaskRequest(payload, env)

  if (payload.taskId !== taskId) {
    throw createTaskNotFoundError()
  }

  const snapshot = createInitialTaskSnapshot({
    taskId,
    ...createInput,
    clientHash: readInternalNullableString(payload, 'clientHash'),
    clientUserAgent: readInternalNullableString(payload, 'clientUserAgent'),
    clientIpHash: readInternalNullableString(payload, 'clientIpHash'),
    env,
  })

  await insertTaskSnapshot(env.DB, snapshot)
  if (snapshot.clientHash) {
    await incrementTaskCreatedUsage(env.DB, {
      clientHash: snapshot.clientHash,
    })
  }
  await sendGa4TaskEvent({
    env,
    snapshot,
    name: 'parseotter_task_created',
  })

  return jsonSuccess(serializeTaskResponse(snapshot), {
    status: 201,
    requestId,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
    },
  })
}

export async function getTask(env: CloudflareBindings, taskId: string, requestId: string): Promise<Response> {
  const snapshot = await reconcileTaskSnapshot({
    db: env.DB,
    bucket: env.R2_BUCKET,
    env,
    taskId,
  })

  return createTaskSnapshotResponse(snapshot, requestId)
}

export async function getDownload(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  requestId: string
): Promise<Response> {
  const snapshot = await getAccessibleTaskSnapshot(env.DB, taskId)
  const clientHash = readClientHashHeader(request)
  if (clientHash) {
    await assertDownloadAllowed({
      db: env.DB,
      env,
      clientHash,
      taskId: snapshot.taskId,
      requestId,
    })
  }
  const download = await createDownloadResultResponse({
    snapshot,
    bucket: env.R2_BUCKET,
    env,
  })
  if (clientHash) {
    await insertClientActionEvent(env.DB, {
      clientHash,
      route: 'download',
      taskId: snapshot.taskId,
    })
  }

  return jsonSuccess(download, {
    requestId,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
    },
  })
}
