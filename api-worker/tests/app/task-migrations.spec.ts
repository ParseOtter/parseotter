import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create-app'
import { findTaskSnapshotById, insertTaskSnapshot } from '../../src/app/tasks/task-record'
import type { TaskSnapshot } from '../../src/app/tasks/task-status'
import { resetTaskDatabaseFromMigrations } from '../support/task-db'

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
  partCount: number
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
    uploadId: string | null
    inputSizeBytes: number | null
    inputPartCount: number | null
  }
  dispatch: {
    status: string | null
    attempt: number
  }
}

const MINIMAL_PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'

describe('task migrations', () => {
  beforeEach(async () => {
    Object.assign(env, {
      MODAL_DISPATCH_URL: '',
    })
    await resetTaskDatabaseFromMigrations(env.DB)
  })

  it('applies the initial schema migration and round-trips a complete task snapshot', async () => {
    const snapshot: TaskSnapshot = {
      taskId: 'task_migrationsnapshot123456789012345',
      status: 'succeeded',
      visibleStatus: 'Conversion complete',
      version: 7,
      attempt: 2,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:10:00.000Z',
      expiresAt: '2026-04-28T00:00:00.000Z',
      expiredAt: null,
      errorCode: null,
      errorMessage: null,
      fileName: 'migration.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: 12345,
      uploadId: 'upload_migration',
      uploadStatus: 'completed',
      inputObjectKey: 'parseotter/task_migrationsnapshot123456789012345/input/original.pdf',
      inputSizeBytes: 12345,
      inputEtag: 'input-etag',
      inputContentType: 'application/pdf',
      inputPartCount: 1,
      inputChecksumSha256: 'input-sha256',
      outputObjectKey: 'parseotter/task_migrationsnapshot123456789012345/output/result.zip',
      outputContentType: 'application/zip',
      outputSizeBytes: 67890,
      dispatchStatus: 'completed',
      dispatchAttempt: 1,
      dispatchIdempotencyKey: 'task_migrationsnapshot123456789012345:dispatch:1',
      dispatchStartedAt: '2026-04-26T00:05:00.000Z',
      dispatchCompletedAt: '2026-04-26T00:10:00.000Z',
      lastCallbackIdempotencyKey: 'callback-migration',
      clientHash: 'a'.repeat(64),
      clientUserAgent: 'migration-test-agent',
      clientIpHash: 'b'.repeat(64),
      gaClientId: '12345.67890',
    }

    await insertTaskSnapshot(env.DB, snapshot)

    await expect(findTaskSnapshotById(env.DB, snapshot.taskId)).resolves.toEqual(snapshot)
  })

  it('supports create, upload session, and complete routes on the migration schema', async () => {
    const app = createApp()
    const fileSizeBytes = new TextEncoder().encode(MINIMAL_PDF_BYTES).byteLength

    const createResponse = await app.request(
      'https://backend.test/api/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'migration-route.pdf',
          fileType: 'application/pdf',
          fileSizeBytes,
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
    const inputObjectKey = `parseotter/${created.taskId}/input/original.pdf`
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(inputObjectKey, upload.uploadId)
    const uploadedPart = await multipartUpload.uploadPart(1, MINIMAL_PDF_BYTES)

    const completeResponse = await app.request(
      `https://backend.test/api/tasks/${created.taskId}/uploads/${upload.uploadId}/complete`,
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

    const payload = (await completeResponse.json()) as ApiEnvelope<TaskStatePayload>

    expect(payload).toMatchObject({
      success: true,
      error: null,
      data: {
        taskId: created.taskId,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'MODAL_DISPATCH_FAILED',
        },
        upload: {
          uploadId: upload.uploadId,
          inputSizeBytes: created.file.sizeBytes,
          inputPartCount: upload.partCount,
        },
        dispatch: {
          status: 'failed',
          attempt: 1,
        },
      },
    })

    const row = await env.DB.prepare(
      `SELECT status, upload_status, input_size_bytes, input_part_count, dispatch_status, dispatch_attempt
       FROM parseotter_tasks WHERE task_id = ?`
    )
      .bind(created.taskId)
      .first<{
        status: string
        upload_status: string
        input_size_bytes: number
        input_part_count: number
        dispatch_status: string
        dispatch_attempt: number
      }>()

    expect(row).toEqual({
      status: 'failed',
      upload_status: 'completed',
      input_size_bytes: created.file.sizeBytes,
      input_part_count: upload.partCount,
      dispatch_status: 'failed',
      dispatch_attempt: 1,
    })
  })
})
