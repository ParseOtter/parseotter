import type { Hono } from 'hono'

import { createApiKeyClientIdentity, createClientIdentity, type ClientIdentity, resolveClientIdentity } from '../abuse/client-identity'
import { readAbuseLimitingEnabled } from '../abuse/abuse-config'
import {
  assertCreateTaskAllowed,
  recordAbuseEvent,
  recordTurnstileFailedUsage,
} from '../abuse/usage'
import type { AppEnv } from '../env'
import { AppHttpError } from '../http/errors'
import { readJsonObject } from '../http/json-body'
import { verifyTurnstileToken } from '../security/turnstile'
import { parseModalCallbackRequest, verifyModalCallbackRequest } from '../tasks/modal-callback'
import { createTaskId, isValidTaskId } from '../tasks/task-id'
import { parseCreateTaskRequest } from '../tasks/task-validation'

const COORDINATOR_ORIGIN = 'https://task-coordinator.internal'

function assertTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)) {
    throw new AppHttpError({
      status: 404,
      code: 'TASK_NOT_FOUND',
      message: 'Task was not found',
    })
  }
}

function createCoordinatorRequest(input: {
  taskId: string
  method: 'GET' | 'POST'
  requestId: string
  pathSuffix?: string
  body?: Record<string, unknown>
  backendOrigin?: string
  clientHash?: string
}): Request {
  const headers = new Headers({
    'x-request-id': input.requestId,
  })
  if (input.backendOrigin) {
    headers.set('x-backend-origin', input.backendOrigin)
  }
  if (input.clientHash) {
    headers.set('x-client-hash', input.clientHash)
  }
  const body = input.body ? JSON.stringify(input.body) : undefined

  if (body) {
    headers.set('content-type', 'application/json')
  }

  return new Request(`${COORDINATOR_ORIGIN}/tasks/${input.taskId}${input.pathSuffix ?? ''}`, {
    method: input.method,
    headers,
    body,
  })
}

async function recordTurnstileFailure(input: {
  env: CloudflareBindings
  requestId: string
  clientIdentity: ClientIdentity
}): Promise<void> {
  const now = new Date()
  await recordTurnstileFailedUsage(input.env.DB, {
    clientHash: input.clientIdentity.clientHash,
    now,
  })
  await recordAbuseEvent(input.env.DB, {
    route: 'create_task',
    eventType: 'turnstile_failed',
    reasonCode: 'TURNSTILE_FAILED',
    status: 403,
    clientHash: input.clientIdentity.clientHash,
    requestId: input.requestId,
    now,
  })
}

async function fetchCoordinatorResponse(stub: DurableObjectStub, request: Request): Promise<Response> {
  const response = await stub.fetch(request)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

async function createAbuseClientIdentity(env: CloudflareBindings, request: Request): Promise<ClientIdentity | null> {
  if (!readAbuseLimitingEnabled(env)) {
    return null
  }

  return createClientIdentity(request)
}

export function registerTaskRoutes(app: Hono<AppEnv>): void {
  app.post('/api/internal/modal/callback', async (c) => {
    const body = await c.req.raw.text()
    await verifyModalCallbackRequest({
      body,
      headers: c.req.raw.headers,
      env: c.env,
    })

    const callback = parseModalCallbackRequest(body)
    assertTaskId(callback.taskId)

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(callback.taskId),
      createCoordinatorRequest({
        taskId: callback.taskId,
        method: 'POST',
        requestId: c.get('requestId'),
        pathSuffix: '/modal-callback',
        body: callback,
        backendOrigin: new URL(c.req.url).origin,
      })
    )
  })

  app.post('/api/tasks', async (c) => {
    const payload = await readJsonObject(c.req.raw)
    const createInput = parseCreateTaskRequest(payload, c.env)
    const apiKeyRecord = c.get('apiKeyRecord')

    let clientIdentity: ClientIdentity | null = null

    if (apiKeyRecord) {
      // API key path: skip Turnstile, go directly to abuse check
      clientIdentity = await createApiKeyClientIdentity(apiKeyRecord.keyId)
      await assertCreateTaskAllowed({
        db: c.env.DB,
        env: c.env,
        clientHash: clientIdentity.clientHash,
        fileSizeBytes: createInput.fileSizeBytes,
        requestId: c.get('requestId'),
      })
    } else {
      // Existing Turnstile path (unchanged for browser users)
      clientIdentity = await createAbuseClientIdentity(c.env, c.req.raw)

      if (clientIdentity) {
        try {
          await verifyTurnstileToken({
            env: c.env,
            token: createInput.turnstileToken,
            remoteIp: clientIdentity.remoteIp,
          })
        } catch (error) {
          await recordTurnstileFailure({
            env: c.env,
            requestId: c.get('requestId'),
            clientIdentity,
          })
          throw error
        }

        await assertCreateTaskAllowed({
          db: c.env.DB,
          env: c.env,
          clientHash: clientIdentity?.clientHash,
          fileSizeBytes: createInput.fileSizeBytes,
          requestId: c.get('requestId'),
        })
      }
    }

    const taskId = createTaskId()
    const taskCoordinator = c.env.TASK_COORDINATOR.getByName(taskId)

    return fetchCoordinatorResponse(
      taskCoordinator,
      createCoordinatorRequest({
        taskId,
        method: 'POST',
        requestId: c.get('requestId'),
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
        body: {
          taskId,
          ...createInput,
          clientHash: clientIdentity?.clientHash ?? null,
          clientUserAgent: clientIdentity?.userAgent ?? null,
          clientIpHash: clientIdentity?.clientIpHash ?? null,
        },
      })
    )
  })

  app.post('/api/tasks/:taskId/uploads', async (c) => {
    const taskId = c.req.param('taskId')
    assertTaskId(taskId)
    const clientIdentity = await resolveClientIdentity(c.env, c.req.raw, c.get('apiKeyRecord'), c.get('requestId'))

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(taskId),
      createCoordinatorRequest({
        taskId,
        method: 'POST',
        requestId: c.get('requestId'),
        pathSuffix: '/uploads',
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
      })
    )
  })

  app.post('/api/tasks/:taskId/uploads/:uploadId/parts/sign', async (c) => {
    const taskId = c.req.param('taskId')
    assertTaskId(taskId)

    const payload = await readJsonObject(c.req.raw)
    const uploadId = c.req.param('uploadId')
    const clientIdentity = await resolveClientIdentity(c.env, c.req.raw, c.get('apiKeyRecord'), c.get('requestId'))

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(taskId),
      createCoordinatorRequest({
        taskId,
        method: 'POST',
        requestId: c.get('requestId'),
        pathSuffix: `/uploads/${encodeURIComponent(uploadId)}/parts/sign`,
        body: payload,
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
      })
    )
  })

  app.post('/api/tasks/:taskId/uploads/:uploadId/complete', async (c) => {
    const taskId = c.req.param('taskId')
    assertTaskId(taskId)

    const payload = await readJsonObject(c.req.raw)
    const uploadId = c.req.param('uploadId')
    const clientIdentity = await resolveClientIdentity(c.env, c.req.raw, c.get('apiKeyRecord'), c.get('requestId'))

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(taskId),
      createCoordinatorRequest({
        taskId,
        method: 'POST',
        requestId: c.get('requestId'),
        pathSuffix: `/uploads/${encodeURIComponent(uploadId)}/complete`,
        body: payload,
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
      })
    )
  })

  app.post('/api/tasks/:taskId/uploads/:uploadId/abort', async (c) => {
    const taskId = c.req.param('taskId')
    assertTaskId(taskId)

    const uploadId = c.req.param('uploadId')
    const clientIdentity = await resolveClientIdentity(c.env, c.req.raw, c.get('apiKeyRecord'), c.get('requestId'))

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(taskId),
      createCoordinatorRequest({
        taskId,
        method: 'POST',
        requestId: c.get('requestId'),
        pathSuffix: `/uploads/${encodeURIComponent(uploadId)}/abort`,
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
      })
    )
  })

  app.get('/api/tasks/:taskId/download', async (c) => {
    const taskId = c.req.param('taskId')
    assertTaskId(taskId)
    const clientIdentity = await resolveClientIdentity(c.env, c.req.raw, c.get('apiKeyRecord'), c.get('requestId'))

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(taskId),
      createCoordinatorRequest({
        taskId,
        method: 'GET',
        requestId: c.get('requestId'),
        pathSuffix: '/download',
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
      })
    )
  })

  app.get('/api/tasks/:taskId', async (c) => {
    const taskId = c.req.param('taskId')
    assertTaskId(taskId)
    const clientIdentity = await resolveClientIdentity(c.env, c.req.raw, c.get('apiKeyRecord'), c.get('requestId'))

    return fetchCoordinatorResponse(
      c.env.TASK_COORDINATOR.getByName(taskId),
      createCoordinatorRequest({
        taskId,
        method: 'GET',
        requestId: c.get('requestId'),
        backendOrigin: new URL(c.req.url).origin,
        clientHash: clientIdentity?.clientHash,
      })
    )
  })
}
