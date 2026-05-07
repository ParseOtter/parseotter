import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../src/app/create-app'
import { signModalCallbackBody } from '../../src/app/security/modal-callback-signature'
import { resetTaskDatabase } from '../support/task-db'

type ApiEnvelope<T> = {
  success: boolean
  data: T
  error: null | {
    code: string
    message: string
  }
}

type TaskPayload = {
  taskId: string
  file: {
    sizeBytes: number
  }
}

type UploadSessionPayload = {
  uploadId: string
}

type TaskStatePayload = {
  taskId: string
  status: string
  visibleStatus: string
  error: null | {
    code: string
    message: string | null
  }
  upload: {
    inputSizeBytes: number | null
    inputContentType: string | null
    inputChecksumSha256: string | null
  }
  output: {
    contentType: string | null
    sizeBytes: number | null
  }
  dispatch: {
    status: string | null
    attempt: number
    completedAt: string | null
  }
}

type DownloadPayload = {
  taskId: string
  url: string
  expiresInSeconds: number
}

type DispatchFetchCall = {
  request: Request
  body: Record<string, unknown>
}

const MINIMAL_PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'
const MODAL_DISPATCH_URL = 'https://modal.example.test/api/internal/cloudflare/jobs/dispatch'
const MODAL_DISPATCH_API_KEY = 'modal-api-key'
const MODAL_CALLBACK_SECRET = 'modal-callback-secret'
const TEST_R2_ACCESS_KEY_ID = 'test-access-key'
const TEST_R2_SECRET_ACCESS_KEY = 'test-secret-key'

const ORIGINAL_ENV = {
  MODAL_DISPATCH_URL: env.MODAL_DISPATCH_URL,
  MODAL_DISPATCH_API_KEY: env.MODAL_DISPATCH_API_KEY,
  MODAL_CALLBACK_HMAC_SECRET: env.MODAL_CALLBACK_HMAC_SECRET,
  DOWNLOAD_URL_TTL_SECONDS: env.DOWNLOAD_URL_TTL_SECONDS,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
}

function configureModalEnv(): void {
  Object.assign(env, {
    MODAL_DISPATCH_URL,
    MODAL_DISPATCH_API_KEY,
    MODAL_CALLBACK_HMAC_SECRET: MODAL_CALLBACK_SECRET,
    DOWNLOAD_URL_TTL_SECONDS: '600',
    R2_ACCESS_KEY_ID: TEST_R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: TEST_R2_SECRET_ACCESS_KEY,
  })
}

function restoreModalEnv(): void {
  Object.assign(env, ORIGINAL_ENV)
}

function stubModalDispatch(status = 202, body?: Record<string, unknown>): DispatchFetchCall[] {
  const calls: DispatchFetchCall[] = []

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = (await request.clone().json()) as Record<string, unknown>
    calls.push({
      request: request.clone(),
      body,
    })

    return new Response(JSON.stringify(body ?? { accepted: status >= 200 && status < 300 }), {
      status,
      headers: {
        'content-type': 'application/json',
      },
    })
  })

  return calls
}

async function createTaskAndUpload(app: ReturnType<typeof createApp>): Promise<{
  task: TaskPayload
  upload: UploadSessionPayload
}> {
  const createResponse = await app.request(
    'https://backend.test/api/tasks',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'sample.pdf',
        fileType: 'application/pdf',
        fileSizeBytes: new TextEncoder().encode(MINIMAL_PDF_BYTES).byteLength,
      }),
    },
    env
  )
  const task = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

  const uploadResponse = await app.request(
    `https://backend.test/api/tasks/${task.taskId}/uploads`,
    {
      method: 'POST',
    },
    env
  )
  const upload = ((await uploadResponse.json()) as ApiEnvelope<UploadSessionPayload>).data

  return { task, upload }
}

async function completeUpload(app: ReturnType<typeof createApp>): Promise<TaskStatePayload> {
  const { task, upload } = await createTaskAndUpload(app)
  const inputObjectKey = `parseotter/${task.taskId}/input/original.pdf`
  const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
  const uploadedPart = await multipartUpload.uploadPart(1, MINIMAL_PDF_BYTES)

  const completeResponse = await app.request(
    `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        parts: [
          {
            partNumber: uploadedPart.partNumber,
            etag: uploadedPart.etag,
          },
        ],
      }),
    },
    env
  )

  const responseText = await completeResponse.clone().text()
  expect(completeResponse.status, responseText).toBe(200)

  return ((await completeResponse.json()) as ApiEnvelope<TaskStatePayload>).data
}

async function postSignedCallback(
  app: ReturnType<typeof createApp>,
  callbackBody: Record<string, unknown>,
  input?: {
    secret?: string
    timestamp?: string
    signature?: string
  }
): Promise<Response> {
  const body = JSON.stringify(callbackBody)
  const timestamp = input?.timestamp ?? String(Math.floor(Date.now() / 1000))
  const signature =
    input?.signature ??
    (await signModalCallbackBody({
      body,
      secret: input?.secret ?? MODAL_CALLBACK_SECRET,
      timestamp,
    }))

  return app.request(
    'https://backend.test/api/internal/modal/callback',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-modal-timestamp': timestamp,
        'x-modal-signature': signature,
      },
      body,
    },
    env
  )
}

function expectTaskStateHidesInternalFields(task: TaskStatePayload): void {
  const rawTask = task as unknown as {
    upload: Record<string, unknown>
    output: Record<string, unknown>
    dispatch: Record<string, unknown>
  }

  expect(rawTask.upload).not.toHaveProperty('inputObjectKey')
  expect(rawTask.output).not.toHaveProperty('objectKey')
  expect(rawTask.dispatch).not.toHaveProperty('idempotencyKey')
  expect(rawTask.dispatch).not.toHaveProperty('lastCallbackIdempotencyKey')
}

describe('Modal dispatch and callback routes', () => {
  beforeEach(async () => {
    configureModalEnv()
    await resetTaskDatabase(env.DB)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreModalEnv()
  })

  it('dispatches Modal after upload completion with the free zip output profile', async () => {
    const app = createApp()
    const dispatchCalls = stubModalDispatch()

    const completed = await completeUpload(app)

    expect(completed).toMatchObject({
      status: 'processing',
      visibleStatus: 'Converting',
      error: null,
      dispatch: {
        status: 'dispatched',
        attempt: 1,
      },
    })
    expectTaskStateHidesInternalFields(completed)
    expect(dispatchCalls).toHaveLength(1)

    const expectedInputObjectKey = `parseotter/${completed.taskId}/input/original.pdf`
    const dispatchedRequest = dispatchCalls[0].request
    expect(dispatchedRequest.url).toBe(MODAL_DISPATCH_URL)
    expect(dispatchedRequest.method).toBe('POST')
    expect(dispatchedRequest.headers.get('x-api-key')).toBe(MODAL_DISPATCH_API_KEY)
    expect(dispatchedRequest.headers.get('x-idempotency-key')).toBe(`${completed.taskId}:dispatch:1`)
    expect(dispatchCalls[0].body).toMatchObject({
      jobId: completed.taskId,
      userId: 'parseotter_free',
      attempt: 1,
      input: {
        objectKey: expectedInputObjectKey,
        contentType: 'application/pdf',
        sizeBytes: completed.upload.inputSizeBytes,
        checksumSha256: completed.upload.inputChecksumSha256,
      },
      output: {
        objectKey: `parseotter/${completed.taskId}/output/result.zip`,
        format: 'zip',
      },
      options: {
        enable_translation: false,
        target_language: '',
        output_profile: 'parseotter_free_v1',
      },
      targetLanguage: '',
      callback: {
        url: 'https://backend.test/api/internal/modal/callback',
        authHeaderName: 'X-Modal-Signature',
        idempotencyKey: `${completed.taskId}:callback:1`,
      },
    })
  })

  it('marks the task failed when Modal dispatch is rejected', async () => {
    const app = createApp()
    stubModalDispatch(503, { detail: 'failed to download R2 object: 404' })

    const completed = await completeUpload(app)

    expect(completed).toMatchObject({
      status: 'failed',
      visibleStatus: 'Conversion failed',
      error: {
        code: 'MODAL_DISPATCH_FAILED',
        message: 'Modal dispatch failed: HTTP 503',
      },
      dispatch: {
        status: 'failed',
        attempt: 1,
      },
    })
  })

  it('rejects unsigned Modal callbacks before updating task state', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)

    const response = await postSignedCallback(
      app,
      {
        taskId: dispatched.taskId,
        jobId: dispatched.taskId,
        status: 'completed',
        outputObjectKey: `parseotter/${dispatched.taskId}/output/result.zip`,
        outputContentType: 'application/zip',
        attempt: 1,
        idempotencyKey: `${dispatched.taskId}:callback:1`,
      },
      {
        signature: 'not-a-valid-signature',
      }
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'CALLBACK_UNAUTHORIZED',
      },
    })

    const row = await env.DB.prepare('SELECT status FROM parseotter_tasks WHERE task_id = ?')
      .bind(dispatched.taskId)
      .first<{ status: string }>()
    expect(row?.status).toBe('processing')
  })

  it('rejects a signed Modal callback before dispatch starts', async () => {
    const app = createApp()
    const { task } = await createTaskAndUpload(app)

    const response = await postSignedCallback(app, {
      taskId: task.taskId,
      jobId: task.taskId,
      status: 'failed',
      errorCode: 'MODAL_PROCESSING_FAILED',
      errorMessage: 'Modal worker failed early',
      attempt: 1,
      idempotencyKey: `${task.taskId}:callback:1`,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'CALLBACK_STATE_CONFLICT',
        details: {
          reason: 'TASK_NOT_AWAITING_MODAL_CALLBACK',
        },
      },
    })

    const row = await env.DB.prepare(
      `SELECT status, dispatch_status, last_callback_idempotency_key
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(task.taskId)
      .first<{
        status: string
        dispatch_status: string | null
        last_callback_idempotency_key: string | null
      }>()

    expect(row).toMatchObject({
      status: 'upload_pending',
      dispatch_status: null,
      last_callback_idempotency_key: null,
    })
  })

  it('rejects stale signed Modal callbacks without updating task state', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)

    await env.DB.prepare(
      `UPDATE parseotter_tasks
       SET attempt = ?, dispatch_attempt = ?, dispatch_idempotency_key = ?, version = version + 1
       WHERE task_id = ?`
    )
      .bind(2, 2, `${dispatched.taskId}:dispatch:2`, dispatched.taskId)
      .run()

    const response = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'failed',
      errorCode: 'MODAL_PROCESSING_FAILED',
      errorMessage: 'Stale Modal worker failed',
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:1`,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'CALLBACK_STATE_CONFLICT',
        details: {
          reason: 'ATTEMPT_MISMATCH',
        },
      },
    })

    const row = await env.DB.prepare(
      `SELECT status, attempt, dispatch_attempt, last_callback_idempotency_key
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(dispatched.taskId)
      .first<{
        status: string
        attempt: number
        dispatch_attempt: number
        last_callback_idempotency_key: string | null
      }>()

    expect(row).toMatchObject({
      status: 'processing',
      attempt: 2,
      dispatch_attempt: 2,
      last_callback_idempotency_key: null,
    })
  })

  it('rejects signed Modal callbacks with the wrong callback idempotency key', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)

    const response = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'failed',
      errorCode: 'MODAL_PROCESSING_FAILED',
      errorMessage: 'Modal worker failed with a wrong key',
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:wrong`,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'CALLBACK_STATE_CONFLICT',
        details: {
          reason: 'IDEMPOTENCY_KEY_MISMATCH',
        },
      },
    })

    const row = await env.DB.prepare(
      `SELECT status, dispatch_status, last_callback_idempotency_key
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(dispatched.taskId)
      .first<{
        status: string
        dispatch_status: string
        last_callback_idempotency_key: string | null
      }>()

    expect(row).toMatchObject({
      status: 'processing',
      dispatch_status: 'dispatched',
      last_callback_idempotency_key: null,
    })
  })

  it('applies a successful Modal callback and exposes a presigned zip download URL', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)
    const outputObjectKey = `parseotter/${dispatched.taskId}/output/result.zip`

    await env.R2_BUCKET.put(outputObjectKey, 'zip-bytes', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })

    const callbackResponse = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'completed',
      outputObjectKey,
      outputContentType: 'application/zip',
      errorCode: null,
      errorMessage: null,
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:1`,
    })

    expect(callbackResponse.status).toBe(200)
    const callbackPayload = (await callbackResponse.json()) as ApiEnvelope<TaskStatePayload>
    expect(callbackPayload.data).toMatchObject({
      status: 'succeeded',
      visibleStatus: 'Conversion complete',
      error: null,
      output: {
        contentType: 'application/zip',
        sizeBytes: 'zip-bytes'.length,
      },
      dispatch: {
        status: 'completed',
      },
    })
    expectTaskStateHidesInternalFields(callbackPayload.data)

    const downloadResponse = await app.request(
      `https://backend.test/api/tasks/${dispatched.taskId}/download`,
      {},
      env
    )
    const downloadText = await downloadResponse.clone().text()
    expect(downloadResponse.status, downloadText).toBe(200)

    const downloadPayload = (await downloadResponse.json()) as ApiEnvelope<DownloadPayload>
    expect(downloadPayload.data).toMatchObject({
      taskId: dispatched.taskId,
      expiresInSeconds: 600,
    })

    const signedUrl = new URL(downloadPayload.data.url)
    expect(signedUrl.pathname).toBe(`/parseotter-files-dev/${outputObjectKey}`)
    expect(signedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('600')
  })

  it('maps failed Modal callbacks to conversion failure', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)

    const callbackResponse = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'failed',
      outputObjectKey: null,
      errorCode: 'MODAL_PROCESSING_FAILED',
      errorMessage: 'Modal worker failed',
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:1`,
    })

    expect(callbackResponse.status).toBe(200)
    await expect(callbackResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_PROCESSING_FAILED',
          message: 'Modal worker failed',
        },
        dispatch: {
          status: 'completed',
        },
      },
    })
  })

  it('maps failed Modal callbacks to conversion failure without overriding a prior success', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)
    const outputObjectKey = `parseotter/${dispatched.taskId}/output/result.zip`

    await env.R2_BUCKET.put(outputObjectKey, 'zip-bytes', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })

    const successResponse = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'completed',
      outputObjectKey,
      outputContentType: 'application/zip',
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:1`,
    })
    expect(successResponse.status).toBe(200)

    const failedReplayResponse = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'failed',
      outputObjectKey: null,
      errorCode: 'MODAL_PROCESSING_FAILED',
      errorMessage: 'OCR failed',
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:failed-replay`,
    })

    expect(failedReplayResponse.status).toBe(200)
    await expect(failedReplayResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        status: 'succeeded',
        visibleStatus: 'Conversion complete',
        error: null,
      },
    })
  })

  it('rejects downloads when the successful task output is missing from R2', async () => {
    const app = createApp()
    stubModalDispatch()
    const dispatched = await completeUpload(app)
    const outputObjectKey = `parseotter/${dispatched.taskId}/output/result.zip`

    await env.R2_BUCKET.put(outputObjectKey, 'zip-bytes', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })
    const callbackResponse = await postSignedCallback(app, {
      taskId: dispatched.taskId,
      jobId: dispatched.taskId,
      status: 'completed',
      outputObjectKey,
      outputContentType: 'application/zip',
      attempt: 1,
      idempotencyKey: `${dispatched.taskId}:callback:1`,
    })
    expect(callbackResponse.status).toBe(200)

    await env.R2_BUCKET.delete(outputObjectKey)

    const downloadResponse = await app.request(
      `https://backend.test/api/tasks/${dispatched.taskId}/download`,
      {},
      env
    )

    expect(downloadResponse.status).toBe(404)
    await expect(downloadResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'RESULT_NOT_FOUND',
      },
    })
  })
})
