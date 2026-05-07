import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create-app'
import { resetTaskDatabase } from '../support/task-db'

type ApiEnvelope<T> = {
  success: boolean
  data: T
  error: null | {
    code: string
    message: string
    details?: {
      issues?: Array<{
        field: string
        code: string
        message: string
      }>
    }
  }
}

type TaskPayload = {
  taskId: string
  status: string
  visibleStatus: string
  version: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  file: {
    name: string
    type: string
    sizeBytes: number
  }
}

type UploadSessionPayload = {
  taskId: string
  uploadId: string
  status: string
  partSizeBytes: number
  partCount: number
  presignedUrlTtlSeconds: number
}

type SignedPartPayload = {
  taskId: string
  uploadId: string
  parts: Array<{
    partNumber: number
    url: string
  }>
}

type TaskStatePayload = TaskPayload & {
  error: null | {
    code: string
    message: string | null
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
  dispatch: {
    status: string | null
    attempt: number
    startedAt: string | null
    completedAt: string | null
  }
}

const MINIMAL_EPUB_BYTES_BASE64 =
  'UEsDBBQAAAAAANuomVxvYassFAAAABQAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi9lcHViK3ppcFBLAwQUAAAACADbqJlcoLdPJiYAAAArAAAAFQAAAE9FQlBTL2NoYXB0ZXItMS54aHRtbLPJKMnNsbNJyk+ptLMpsMtIzcnJV0gtKE2y0S+ws9GHiOuDFQEAUEsBAhQDFAAAAAAA26iZXG9hqywUAAAAFAAAAAgAAAAAAAAAAAAAAIABAAAAAG1pbWV0eXBlUEsBAhQDFAAAAAgA26iZXKC3TyYmAAAAKwAAABUAAAAAAAAAAAAAAIABOgAAAE9FQlBTL2NoYXB0ZXItMS54aHRtbFBLBQYAAAAAAgACAHkAAACTAAAAAAA='
const MINIMAL_PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'
const TEST_R2_ACCESS_KEY_ID = 'test-access-key'
const TEST_R2_SECRET_ACCESS_KEY = 'test-secret-key'

function decodeBase64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

async function putInputObject(input: {
  taskId: string
  fileType: string
  bytes: string | Uint8Array
}): Promise<string> {
  const inputObjectKey = `parseotter/${input.taskId}/input/original.${
    input.fileType === 'application/pdf' ? 'pdf' : 'epub'
  }`

  await env.R2_BUCKET.put(inputObjectKey, input.bytes, {
    httpMetadata: {
      contentType: input.fileType,
    },
  })

  return inputObjectKey
}

async function createTaskAndUpload(
  app: ReturnType<typeof createApp>,
  input?: {
    fileName?: string
    fileType?: string
    fileSizeBytes?: number
  }
): Promise<{
  task: TaskPayload
  upload: UploadSessionPayload
}> {
  const fileName = input?.fileName ?? 'sample.pdf'
  const fileType = input?.fileType ?? 'application/pdf'
  const fileSizeBytes = input?.fileSizeBytes ?? 12345

  const createResponse = await app.request(
    'https://backend.test/api/tasks',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName,
        fileType,
        fileSizeBytes,
      }),
    },
    env
  )
  const createResponseText = await createResponse.clone().text()
  expect(createResponse.status, createResponseText).toBe(201)
  const task = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

  const uploadResponse = await app.request(
    `https://backend.test/api/tasks/${task.taskId}/uploads`,
    {
      method: 'POST',
    },
    env
  )
  const upload = ((await uploadResponse.json()) as ApiEnvelope<UploadSessionPayload>).data

  return {
    task,
    upload,
  }
}

describe('task routes', () => {
  beforeEach(async () => {
    Object.assign(env, {
      MODAL_DISPATCH_URL: '',
      R2_ACCESS_KEY_ID: TEST_R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: TEST_R2_SECRET_ACCESS_KEY,
    })
    await resetTaskDatabase(env.DB)
  })

  it('creates a task through its Durable Object and persists a D1 snapshot', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
          'x-request-id': 'request-create-task',
        },
        body: JSON.stringify({
          fileName: 'sample.pdf',
          fileType: 'application/pdf',
          fileSizeBytes: 12345,
          gaClientId: '12345.67890',
        }),
      },
      env
    )

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(201)
    expect(response.headers.get('x-request-id')).toBe('request-create-task')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const payload = (await response.json()) as ApiEnvelope<TaskPayload>

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        status: 'created',
        visibleStatus: 'Waiting for upload',
        version: 1,
        file: {
          name: 'sample.pdf',
          type: 'application/pdf',
          sizeBytes: 12345,
        },
      },
    })
    expect(payload.data.taskId).toMatch(/^task_[A-Za-z0-9_-]{32,}$/)

    const row = await env.DB.prepare(
      'SELECT task_id, status, visible_status, file_name, file_type, file_size_bytes, ga_client_id FROM parseotter_tasks WHERE task_id = ?'
    )
      .bind(payload.data.taskId)
      .first<{
        task_id: string
        status: string
        visible_status: string
        file_name: string
        file_type: string
        file_size_bytes: number
        ga_client_id: string | null
      }>()

    expect(row).toEqual({
      task_id: payload.data.taskId,
      status: 'created',
      visible_status: 'Waiting for upload',
      file_name: 'sample.pdf',
      file_type: 'application/pdf',
      file_size_bytes: 12345,
      ga_client_id: '12345.67890',
    })

    const createdAt = Date.parse(payload.data.createdAt)
    const expiresAt = Date.parse(payload.data.expiresAt)
    expect(expiresAt - createdAt).toBe(48 * 60 * 60 * 1000)
  })

  it('hydrates task status from D1 when queried by task id', async () => {
    const app = createApp()

    const createResponse = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'book.epub',
          fileType: 'application/epub+zip',
          fileSizeBytes: 98765,
        }),
      },
      env
    )
    const created = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

    const getResponse = await app.request(`https://backend.test/api/tasks/${created.taskId}`, {}, env)

    expect(getResponse.status).toBe(200)
    await expect(getResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: created.taskId,
        status: 'created',
        visibleStatus: 'Waiting for upload',
        file: {
          name: 'book.epub',
          type: 'application/epub+zip',
          sizeBytes: 98765,
        },
      },
    })
  })

  it('rejects invalid task creation payloads with the common error envelope', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'request-invalid-task',
        },
        body: JSON.stringify({
          fileName: '',
          fileType: 'application/pdf',
          fileSizeBytes: 123,
        }),
      },
      env
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        requestId: 'request-invalid-task',
        details: {
          issues: [
            {
              field: 'fileName',
              code: 'invalid_length',
              message: 'fileName is invalid',
            },
          ],
        },
      },
    })
  })

  it('rejects unsupported file types with the domain error envelope', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'request-invalid-file-type',
        },
        body: JSON.stringify({
          fileName: 'notes.txt',
          fileType: 'text/plain',
          fileSizeBytes: 123,
        }),
      },
      env
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'INVALID_FILE_TYPE',
        message: 'File type is not supported',
        requestId: 'request-invalid-file-type',
      },
    })
  })

  it('rejects files larger than the configured 100 MB public limit before creating a task', async () => {
    const app = createApp()

    const response = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'request-file-too-large',
        },
        body: JSON.stringify({
          fileName: 'large.pdf',
          fileType: 'application/pdf',
          fileSizeBytes: 100 * 1024 * 1024 + 1,
        }),
      },
      {
        ...env,
        MAX_UPLOAD_FILE_SIZE_MB: '100',
      }
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'FILE_TOO_LARGE',
        message: 'File exceeds the 100 MB limit',
        requestId: 'request-file-too-large',
      },
    })
  })

  it('creates an upload session through the task Durable Object and persists multipart metadata', async () => {
    const app = createApp()

    const createResponse = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          fileName: 'sample.pdf',
          fileType: 'application/pdf',
          fileSizeBytes: 12345,
        }),
      },
      env
    )
    const created = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

    const uploadResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost:5173',
          'x-request-id': 'request-create-upload',
        },
      },
      env
    )

    const responseText = await uploadResponse.clone().text()
    expect(uploadResponse.status, responseText).toBe(201)
    expect(uploadResponse.headers.get('x-request-id')).toBe('request-create-upload')
    expect(uploadResponse.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const payload = (await uploadResponse.json()) as ApiEnvelope<UploadSessionPayload>

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: created.taskId,
        status: 'pending',
        partSizeBytes: 5 * 1024 * 1024,
        partCount: 1,
        presignedUrlTtlSeconds: 900,
      },
    })
    expect(payload.data.uploadId).toEqual(expect.any(String))

    const row = await env.DB.prepare(
      `SELECT status, visible_status, upload_id, upload_status, input_object_key, input_content_type,
              dispatch_status, dispatch_attempt, dispatch_idempotency_key
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(created.taskId)
      .first<{
        status: string
        visible_status: string
        upload_id: string
        upload_status: string
        input_object_key: string
        input_content_type: string
        dispatch_status: string | null
        dispatch_attempt: number
        dispatch_idempotency_key: string | null
      }>()

    expect(row).toMatchObject({
      status: 'upload_pending',
      visible_status: 'Waiting for upload',
      upload_id: payload.data.uploadId,
      upload_status: 'pending',
      input_object_key: `parseotter/${created.taskId}/input/original.pdf`,
      input_content_type: 'application/pdf',
      dispatch_status: null,
      dispatch_attempt: 0,
      dispatch_idempotency_key: null,
    })
  })

  it('signs UploadPart URLs for the current task upload session', async () => {
    const app = createApp()

    const createResponse = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          fileName: 'sample.pdf',
          fileType: 'application/pdf',
          fileSizeBytes: 12345,
        }),
      },
      env
    )
    const created = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

    const uploadResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost:5173',
        },
      },
      env
    )
    const upload = ((await uploadResponse.json()) as ApiEnvelope<UploadSessionPayload>).data

    const signResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads/${upload.uploadId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
          'x-request-id': 'request-sign-parts',
        },
        body: JSON.stringify({
          partNumbers: [1],
        }),
      },
      env
    )

    const responseText = await signResponse.clone().text()
    expect(signResponse.status, responseText).toBe(200)
    expect(signResponse.headers.get('x-request-id')).toBe('request-sign-parts')
    expect(signResponse.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const payload = (await signResponse.json()) as ApiEnvelope<SignedPartPayload>

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: created.taskId,
        uploadId: upload.uploadId,
        parts: [
          {
            partNumber: 1,
          },
        ],
      },
    })

    const signedUrl = new URL(payload.data.parts[0].url)
    expect(signedUrl.origin).toBe('https://your-cloudflare-account-id.r2.cloudflarestorage.com')
    expect(signedUrl.pathname).toBe(`/parseotter-files-dev/parseotter/${created.taskId}/input/original.pdf`)
    expect(signedUrl.searchParams.get('partNumber')).toBe('1')
    expect(signedUrl.searchParams.get('uploadId')).toBe(upload.uploadId)
    expect(signedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('900')
  })

  it('rejects signing part URLs for an upload id that is not bound to the task', async () => {
    const app = createApp()

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
          fileSizeBytes: 12345,
        }),
      },
      env
    )
    const created = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

    const uploadResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads`,
      {
        method: 'POST',
      },
      env
    )
    const upload = ((await uploadResponse.json()) as ApiEnvelope<UploadSessionPayload>).data

    const signResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads/not-the-right-upload-id/parts/sign`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [1],
        }),
      },
      env
    )

    expect(upload.uploadId).not.toBe('not-the-right-upload-id')
    expect(signResponse.status).toBe(400)
    await expect(signResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'UPLOAD_PART_INVALID',
        message: 'Upload session is invalid for this task',
      },
    })
  })

  it('rejects signing part URLs for part numbers outside the current multipart range', async () => {
    const app = createApp()

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
          fileSizeBytes: 12345,
        }),
      },
      env
    )
    const created = ((await createResponse.json()) as ApiEnvelope<TaskPayload>).data

    const uploadResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads`,
      {
        method: 'POST',
      },
      env
    )
    const upload = ((await uploadResponse.json()) as ApiEnvelope<UploadSessionPayload>).data

    const signResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads/${upload.uploadId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [2],
        }),
      },
      env
    )

    expect(signResponse.status).toBe(400)
    await expect(signResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'UPLOAD_PART_INVALID',
        message: 'Part number is out of range for this upload',
      },
    })
  })

  it('rejects signing duplicate part numbers for the same upload session', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app)

    const signResponse = await app.request(
      `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [1, 1],
        }),
      },
      env
    )

    expect(signResponse.status).toBe(400)
    await expect(signResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'UPLOAD_PART_INVALID',
        message: 'Part numbers must be unique for this upload',
      },
    })
  })

  it('allows re-signing the same part number for the same upload session', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app)

    const firstSignResponse = await app.request(
      `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [1],
        }),
      },
      env
    )

    const secondSignResponse = await app.request(
      `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [1],
        }),
      },
      env
    )

    expect(firstSignResponse.status).toBe(200)
    expect(secondSignResponse.status).toBe(200)
    await expect(firstSignResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        uploadId: upload.uploadId,
        parts: [
          {
            partNumber: 1,
          },
        ],
      },
    })
    await expect(secondSignResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        uploadId: upload.uploadId,
        parts: [
          {
            partNumber: 1,
          },
        ],
      },
    })
  })

  it('completes a multipart upload, persists object metadata, and fails dispatch when Modal is not configured', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app, {
      fileSizeBytes: new TextEncoder().encode(MINIMAL_PDF_BYTES).byteLength,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.pdf`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, MINIMAL_PDF_BYTES)

    const completeResponse = await app.request(
      `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/complete`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'request-complete-upload',
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
    expect(completeResponse.headers.get('x-request-id')).toBe('request-complete-upload')

    const payload = (await completeResponse.json()) as ApiEnvelope<TaskStatePayload>

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_DISPATCH_FAILED',
          message: 'Modal dispatch failed',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'completed',
          inputSizeBytes: task.file.sizeBytes,
          inputContentType: 'application/pdf',
          inputPartCount: upload.partCount,
        },
        dispatch: {
          status: 'failed',
          attempt: 1,
        },
      },
    })

    const row = await env.DB.prepare(
      `SELECT status, visible_status, upload_status, input_object_key, input_size_bytes, input_etag,
              input_content_type, input_part_count, input_checksum_sha256, dispatch_status, dispatch_attempt,
              dispatch_idempotency_key
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(task.taskId)
      .first<{
        status: string
        visible_status: string
        upload_status: string
        input_object_key: string
        input_size_bytes: number
        input_etag: string
        input_content_type: string
        input_part_count: number
        input_checksum_sha256: string | null
        dispatch_status: string
        dispatch_attempt: number
        dispatch_idempotency_key: string
      }>()

    expect(row).toMatchObject({
      status: 'failed',
      visible_status: 'Conversion failed',
      upload_status: 'completed',
      input_object_key: inputObjectKey,
      input_size_bytes: task.file.sizeBytes,
      input_etag: payload.data.upload.inputEtag,
      input_content_type: 'application/pdf',
      input_part_count: upload.partCount,
      dispatch_status: 'failed',
      dispatch_attempt: 1,
      dispatch_idempotency_key: `${task.taskId}:dispatch:1`,
    })

    const object = await env.R2_BUCKET.head(inputObjectKey)
    expect(object?.etag).toBe(payload.data.upload.inputEtag)
    expect(object?.size).toBeGreaterThan(0)
    expect(object?.size).toBe(row?.input_size_bytes)
    expect(payload.data.upload.inputSizeBytes).toBe(object?.size)
    expect(payload.data.upload.inputPartCount).toBe(upload.partCount)
    expect(row?.input_checksum_sha256).toBe(object?.checksums.toJSON().sha256 ?? null)
    expect(payload.data.upload.inputChecksumSha256).toBe(object?.checksums.toJSON().sha256 ?? null)
  })

  it('completes a valid EPUB upload and fails dispatch when Modal is not configured', async () => {
    const app = createApp()
    const epubBytes = decodeBase64Bytes(MINIMAL_EPUB_BYTES_BASE64)
    const { task, upload } = await createTaskAndUpload(app, {
      fileName: 'book.epub',
      fileType: 'application/epub+zip',
      fileSizeBytes: epubBytes.byteLength,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.epub`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, epubBytes)

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

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_DISPATCH_FAILED',
          message: 'Modal dispatch failed',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'completed',
          inputContentType: 'application/epub+zip',
        },
        dispatch: {
          status: 'failed',
          attempt: 1,
        },
      },
    })
  })

  it('rejects completing a multipart upload when the part manifest is invalid', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app)

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
              partNumber: 1,
              etag: '',
            },
          ],
        }),
      },
      env
    )

    expect(completeResponse.status).toBe(400)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'UPLOAD_PART_INVALID',
        message: 'Completed parts manifest is invalid for this upload',
      },
    })
  })

  it('rejects completing a multipart upload when a non-final part violates the R2 minimum part size', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app, {
      fileSizeBytes: 5 * 1024 * 1024 + 1,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.pdf`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const firstPart = await multipartUpload.uploadPart(1, 'x')
    const secondPart = await multipartUpload.uploadPart(2, 'y')

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
              partNumber: firstPart.partNumber,
              etag: firstPart.etag,
            },
            {
              partNumber: secondPart.partNumber,
              etag: secondPart.etag,
            },
          ],
        }),
      },
      env
    )

    expect(completeResponse.status).toBe(400)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'UPLOAD_PART_INVALID',
        message: 'Completed parts manifest is invalid for this upload',
      },
    })

    const row = await env.DB.prepare(`SELECT status, upload_status FROM parseotter_tasks WHERE task_id = ?`)
      .bind(task.taskId)
      .first<{ status: string; upload_status: string }>()

    expect(row).toMatchObject({
      status: 'upload_pending',
      upload_status: 'pending',
    })
  })

  it('fails a completed upload when declared PDF content does not match the file signature', async () => {
    const app = createApp()
    const invalidPdfBytes = new TextEncoder().encode('not-a-pdf')
    const { task, upload } = await createTaskAndUpload(app, {
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: invalidPdfBytes.byteLength,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.pdf`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, invalidPdfBytes)

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

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'UPLOAD_FAILED',
          message: 'Uploaded file content does not match the declared file type',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'failed',
        },
        dispatch: {
          status: null,
          attempt: 0,
        },
      },
    })
  })

  it('fails a completed upload when the stored object size does not match the declared file size', async () => {
    const app = createApp()
    const actualBytes = new TextEncoder().encode('%PDF-1.7\nsize mismatch\n%%EOF')
    const { task, upload } = await createTaskAndUpload(app, {
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: actualBytes.byteLength + 7,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.pdf`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, actualBytes)

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

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'UPLOAD_FAILED',
          message: 'Uploaded object size does not match the declared file size',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'failed',
        },
        dispatch: {
          status: null,
          attempt: 0,
        },
      },
    })
  })

  it('fails a completed upload when declared EPUB content does not match the file signature', async () => {
    const app = createApp()
    const invalidEpubBytes = new TextEncoder().encode('not-a-zip-archive')
    const { task, upload } = await createTaskAndUpload(app, {
      fileName: 'book.epub',
      fileType: 'application/epub+zip',
      fileSizeBytes: invalidEpubBytes.byteLength,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.epub`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, invalidEpubBytes)

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

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'UPLOAD_FAILED',
          message: 'Uploaded file content does not match the declared file type',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'failed',
        },
        dispatch: {
          status: null,
          attempt: 0,
        },
      },
    })
  })

  it('recovers completion when the object already exists but the task snapshot is still pending', async () => {
    const app = createApp()
    const objectBytes = '%PDF-1.7\nrecovered object\n%%EOF'
    const { task, upload } = await createTaskAndUpload(app, {
      fileSizeBytes: new TextEncoder().encode(objectBytes).byteLength,
    })
    const inputObjectKey = await putInputObject({
      taskId: task.taskId,
      fileType: 'application/pdf',
      bytes: objectBytes,
    })
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
              partNumber: 1,
              etag: 'stale-etag',
            },
          ],
        }),
      },
      env
    )

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_DISPATCH_FAILED',
          message: 'Modal dispatch failed',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'completed',
        },
        dispatch: {
          status: 'failed',
          attempt: 1,
        },
      },
    })
  })

  it('fails dispatch when complete is retried after upload completion was already persisted', async () => {
    const app = createApp()
    const objectBytes = '%PDF-1.7\ndispatch pending recovery\n%%EOF'
    const { task, upload } = await createTaskAndUpload(app, {
      fileSizeBytes: new TextEncoder().encode(objectBytes).byteLength,
    })
    const inputObjectKey = await putInputObject({
      taskId: task.taskId,
      fileType: 'application/pdf',
      bytes: objectBytes,
    })

    await env.DB.prepare(
      `UPDATE parseotter_tasks
       SET status = ?, visible_status = ?, upload_status = ?, input_etag = ?, input_content_type = ?, version = version + 1
       WHERE task_id = ?`
    )
      .bind('upload_completed', 'Upload complete', 'completed', 'existing-etag', 'application/pdf', task.taskId)
      .run()

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
              partNumber: 1,
              etag: 'ignored-etag',
            },
          ],
        }),
      },
      env
    )

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_DISPATCH_FAILED',
          message: 'Modal dispatch failed',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'completed',
        },
        dispatch: {
          status: 'failed',
          attempt: 1,
        },
      },
    })
  })

  it('recovers a stale aborted snapshot when the upload object already exists and fails dispatch when Modal is not configured', async () => {
    const app = createApp()
    const objectBytes = '%PDF-1.7\nstale abort recovery\n%%EOF'
    const { task, upload } = await createTaskAndUpload(app, {
      fileSizeBytes: new TextEncoder().encode(objectBytes).byteLength,
    })
    const inputObjectKey = await putInputObject({
      taskId: task.taskId,
      fileType: 'application/pdf',
      bytes: objectBytes,
    })

    await env.DB.prepare(
      `UPDATE parseotter_tasks
       SET status = ?, visible_status = ?, upload_status = ?, error_code = ?, error_message = ?, version = version + 1
       WHERE task_id = ?`
    )
      .bind('failed', 'Conversion failed', 'aborted', 'UPLOAD_ABORTED', 'Upload was aborted', task.taskId)
      .run()

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
              partNumber: 1,
              etag: 'ignored-etag',
            },
          ],
        }),
      },
      env
    )

    expect(completeResponse.status).toBe(200)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_DISPATCH_FAILED',
          message: 'Modal dispatch failed',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'completed',
        },
        dispatch: {
          status: 'failed',
          attempt: 1,
        },
      },
    })
  })

  it('aborts a pending multipart upload and records the task as failed with UPLOAD_ABORTED', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app)

    const abortResponse = await app.request(
      `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/abort`,
      {
        method: 'POST',
        headers: {
          'x-request-id': 'request-abort-upload',
        },
      },
      env
    )

    const responseText = await abortResponse.clone().text()
    expect(abortResponse.status, responseText).toBe(200)
    expect(abortResponse.headers.get('x-request-id')).toBe('request-abort-upload')

    const payload = (await abortResponse.json()) as ApiEnvelope<TaskStatePayload>

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'UPLOAD_ABORTED',
          message: 'Upload was aborted',
        },
        upload: {
          uploadId: upload.uploadId,
          status: 'aborted',
        },
        dispatch: {
          status: null,
          attempt: 0,
        },
      },
    })

    const row = await env.DB.prepare(
      `SELECT status, visible_status, error_code, error_message, upload_status, dispatch_status, dispatch_attempt,
              dispatch_idempotency_key
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(task.taskId)
      .first<{
        status: string
        visible_status: string
        error_code: string
        error_message: string
        upload_status: string
        dispatch_status: string | null
        dispatch_attempt: number
        dispatch_idempotency_key: string | null
      }>()

    expect(row).toMatchObject({
      status: 'failed',
      visible_status: 'Conversion failed',
      error_code: 'UPLOAD_ABORTED',
      error_message: 'Upload was aborted',
      upload_status: 'aborted',
      dispatch_status: null,
      dispatch_attempt: 0,
      dispatch_idempotency_key: null,
    })
  })

  it('rejects completing an upload after it has been aborted', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app)

    await app.request(
      `https://backend.test/api/tasks/${task.taskId}/uploads/${upload.uploadId}/abort`,
      {
        method: 'POST',
      },
      env
    )

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
              partNumber: 1,
              etag: 'etag-1',
            },
          ],
        }),
      },
      env
    )

    expect(completeResponse.status).toBe(409)
    await expect(completeResponse.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'UPLOAD_NOT_COMPLETE',
        message: 'Upload is not pending',
      },
    })
  })

  it('treats complete as idempotent after upload completion even when the task has advanced', async () => {
    const app = createApp()
    const { task, upload } = await createTaskAndUpload(app, {
      fileSizeBytes: new TextEncoder().encode(MINIMAL_PDF_BYTES).byteLength,
    })
    const inputObjectKey = `parseotter/${task.taskId}/input/original.pdf`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, MINIMAL_PDF_BYTES)

    const firstCompleteResponse = await app.request(
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

    expect(firstCompleteResponse.status).toBe(200)

    await env.DB.prepare(
      `UPDATE parseotter_tasks
       SET status = ?, visible_status = ?, version = version + 1
       WHERE task_id = ?`
    )
      .bind('processing', 'Converting', task.taskId)
      .run()

    const secondCompleteResponse = await app.request(
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

    expect(secondCompleteResponse.status).toBe(200)
    await expect(secondCompleteResponse.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: task.taskId,
        status: 'processing',
        visibleStatus: 'Converting',
        upload: {
          uploadId: upload.uploadId,
          status: 'completed',
        },
      },
    })
  })

  it('returns TASK_EXPIRED after the 48-hour accessibility boundary and marks the row expired', async () => {
    const app = createApp()
    const expiredTaskId = 'task_abcdefghijklmnopqrstuvwxyz123456'

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, dispatch_attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        expiredTaskId,
        'processing',
        'Converting',
        1,
        1,
        '2026-04-20T00:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
        '2026-04-22T00:00:00.000Z',
        'expired.pdf',
        'application/pdf',
        123,
        0
      )
      .run()

    const response = await app.request(`https://backend.test/api/tasks/${expiredTaskId}`, {}, env)

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'TASK_EXPIRED',
      },
    })

    const row = await env.DB.prepare('SELECT status, visible_status, expired_at FROM parseotter_tasks WHERE task_id = ?')
      .bind(expiredTaskId)
      .first<{ status: string; visible_status: string; expired_at: string }>()

    expect(row?.status).toBe('expired')
    expect(row?.visible_status).toBe('Expired')
    expect(row?.expired_at).toEqual(expect.any(String))
  })

  it('reconciles a processing task to succeeded when the expected output object already exists', async () => {
    const app = createApp()
    const taskId = 'task_processingreconcilesuccess123456'
    const outputObjectKey = `parseotter/${taskId}/output/result.zip`

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, upload_status, input_object_key, input_size_bytes,
        input_content_type, input_part_count, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
        dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        'processing',
        'Converting',
        6,
        1,
        '2026-04-26T06:53:13.222Z',
        '2026-04-26T06:53:36.880Z',
        '2099-04-28T06:53:13.222Z',
        'stuck.pdf',
        'application/pdf',
        123,
        'completed',
        `parseotter/${taskId}/input/original.pdf`,
        123,
        'application/pdf',
        1,
        'dispatched',
        1,
        `${taskId}:dispatch:1`,
        '2026-04-26T06:53:27.057Z',
        '2026-04-26T06:53:36.880Z',
        null
      )
      .run()

    await env.R2_BUCKET.put(outputObjectKey, 'zip-output', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })

    const response = await app.request(`https://backend.test/api/tasks/${taskId}`, {}, env)

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId,
        status: 'succeeded',
        visibleStatus: 'Conversion complete',
        output: {
          contentType: 'application/zip',
          sizeBytes: 10,
        },
        dispatch: {
          status: 'completed',
        },
      },
    })
  })

  it('reconciles a dispatching task to succeeded when the expected output object already exists', async () => {
    const app = createApp()
    const taskId = 'task_dispatchingreconcilesuccess123456'
    const outputObjectKey = `parseotter/${taskId}/output/result.zip`

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, upload_status, input_object_key, input_size_bytes,
        input_content_type, input_part_count, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
        dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        'dispatching',
        'Converting',
        6,
        1,
        '2026-04-26T06:53:13.222Z',
        '2026-04-26T06:53:36.880Z',
        '2099-04-28T06:53:13.222Z',
        'dispatching-stuck.pdf',
        'application/pdf',
        123,
        'completed',
        `parseotter/${taskId}/input/original.pdf`,
        123,
        'application/pdf',
        1,
        'dispatching',
        1,
        `${taskId}:dispatch:1`,
        '2026-04-26T06:53:27.057Z',
        null,
        null
      )
      .run()

    await env.R2_BUCKET.put(outputObjectKey, 'zip-output', {
      httpMetadata: {
        contentType: 'application/zip',
      },
    })

    const response = await app.request(`https://backend.test/api/tasks/${taskId}`, {}, env)

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId,
        status: 'succeeded',
        visibleStatus: 'Conversion complete',
        output: {
          contentType: 'application/zip',
          sizeBytes: 10,
        },
        dispatch: {
          status: 'completed',
        },
      },
    })
  })

  it('reconciles a stale processing task to failed after the configured processing timeout', async () => {
    const app = createApp()
    const taskId = 'task_processingreconciletimeout123456'
    Object.assign(env, {
      PROCESSING_TIMEOUT_SECONDS: '1800',
    })

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, upload_status, input_object_key, input_size_bytes,
        input_content_type, input_part_count, dispatch_status, dispatch_attempt, dispatch_idempotency_key,
        dispatch_started_at, dispatch_completed_at, last_callback_idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        'processing',
        'Converting',
        6,
        1,
        '2026-04-26T06:53:13.222Z',
        '2026-04-26T06:53:36.880Z',
        '2099-04-28T06:53:13.222Z',
        'stale.pdf',
        'application/pdf',
        123,
        'completed',
        `parseotter/${taskId}/input/original.pdf`,
        123,
        'application/pdf',
        1,
        'dispatched',
        1,
        `${taskId}:dispatch:1`,
        '2026-04-26T00:00:00.000Z',
        '2026-04-26T00:00:10.000Z',
        null
      )
      .run()

    const response = await app.request(`https://backend.test/api/tasks/${taskId}`, {}, env)

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      error: null,
      data: {
        taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'PROCESSING_TIMEOUT',
          message: 'Task exceeded the processing timeout window',
        },
      },
    })
  })

  it('rejects downloads for expired tasks before result lookup is implemented', async () => {
    const app = createApp()
    const expiredTaskId = 'task_abcdefghijklmnopqrstuvwxyz123456'

    await env.DB.prepare(
      `INSERT INTO parseotter_tasks (
        task_id, status, visible_status, version, attempt, created_at, updated_at, expires_at,
        file_name, file_type, file_size_bytes, dispatch_attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        expiredTaskId,
        'succeeded',
        'Conversion complete',
        1,
        1,
        '2026-04-20T00:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
        '2026-04-22T00:00:00.000Z',
        'expired.pdf',
        'application/pdf',
        123,
        0
      )
      .run()

    const response = await app.request(`https://backend.test/api/tasks/${expiredTaskId}/download`, {}, env)

    const responseText = await response.clone().text()
    expect(response.status, responseText).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: null,
      error: {
        code: 'TASK_EXPIRED',
      },
    })
  })
})
