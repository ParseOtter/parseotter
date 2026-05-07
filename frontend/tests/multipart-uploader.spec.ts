import { describe, expect, it, vi } from 'vitest'

import { uploadDocument } from '../src/multipart-uploader'
import type { ParseOtterApiClient } from '../src/parseotter-api'

function createApi(overrides?: Partial<ParseOtterApiClient>): ParseOtterApiClient {
  return {
    createTask: vi.fn(async () => ({
      taskId: 'task_frontendupload12345678901234567890',
      status: 'created',
      visibleStatus: 'Waiting for upload',
      version: 1,
      attempt: 0,
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:00:00.000Z',
      expiresAt: '2026-04-27T00:00:00.000Z',
      expiredAt: null,
      error: null,
      file: {
        name: 'sample.pdf',
        type: 'application/pdf',
        sizeBytes: 8,
      },
      upload: {
        uploadId: null,
        status: null,
        inputObjectKey: null,
        inputSizeBytes: null,
        inputEtag: null,
        inputContentType: null,
        inputPartCount: null,
        inputChecksumSha256: null,
      },
      output: {
        objectKey: null,
        contentType: null,
        sizeBytes: null,
      },
      dispatch: {
        status: null,
        attempt: 0,
        idempotencyKey: null,
        startedAt: null,
        completedAt: null,
        lastCallbackIdempotencyKey: null,
      },
    })),
    createUploadSession: vi.fn(async () => ({
      taskId: 'task_frontendupload12345678901234567890',
      uploadId: 'upload_123',
      status: 'pending',
      partSizeBytes: 4,
      partCount: 1,
      presignedUrlTtlSeconds: 900,
    })),
    signUploadParts: vi.fn(async (_taskId: string, _uploadId: string, partNumbers: number[]) => ({
      taskId: 'task_frontendupload12345678901234567890',
      uploadId: 'upload_123',
      parts: partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://r2.test/upload-part-${partNumber}`,
      })),
    })),
    completeUpload: vi.fn(async () => ({
      taskId: 'task_frontendupload12345678901234567890',
      status: 'dispatch_pending',
      visibleStatus: 'Waiting for conversion',
      version: 2,
      attempt: 1,
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:01:00.000Z',
      expiresAt: '2026-04-27T00:00:00.000Z',
      expiredAt: null,
      error: null,
      file: {
        name: 'sample.pdf',
        type: 'application/pdf',
        sizeBytes: 8,
      },
      upload: {
        uploadId: 'upload_123',
        status: 'completed',
        inputObjectKey: 'parseotter/task_frontendupload12345678901234567890/input/original.pdf',
        inputSizeBytes: 8,
        inputEtag: 'etag-complete',
        inputContentType: 'application/pdf',
        inputPartCount: 2,
        inputChecksumSha256: null,
      },
      output: {
        objectKey: null,
        contentType: null,
        sizeBytes: null,
      },
      dispatch: {
        status: 'pending',
        attempt: 1,
        idempotencyKey: 'task_frontendupload12345678901234567890:dispatch:1',
        startedAt: null,
        completedAt: null,
        lastCallbackIdempotencyKey: null,
      },
    })),
    abortUpload: vi.fn(async () => undefined),
    getTask: vi.fn(),
    getDownload: vi.fn(),
    submitFeedback: vi.fn(),
    ...overrides,
  }
}

function createPdfFile(size = 8): File {
  return new File([new Uint8Array(size).fill(1)], 'sample.pdf', {
    type: 'application/pdf',
  })
}

describe('multipart uploader', () => {
  it('reports uploaded bytes, percent, and average upload speed as parts complete', async () => {
    const api = createApi({
      createUploadSession: vi.fn(async () => ({
        taskId: 'task_frontendupload12345678901234567890',
        uploadId: 'upload_123',
        status: 'pending',
        partSizeBytes: 4,
        partCount: 2,
        presignedUrlTtlSeconds: 900,
      })),
    })
    const r2Fetch = vi.fn(async () => new Response(null, { headers: { ETag: '"etag-1"' } }))
    let nowMs = 1000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1000
      return nowMs
    })
    const progressEvents: Array<{
      uploadedBytes: number
      totalBytes: number
      percent: number
      bytesPerSecond: number
    }> = []

    try {
      await uploadDocument({
        api,
        file: createPdfFile(8),
        r2Fetch,
        partConcurrency: 1,
        onProgress: (progress) => progressEvents.push(progress),
      })
    } finally {
      nowSpy.mockRestore()
    }

    expect(progressEvents).toMatchObject([
      {
        uploadedBytes: 4,
        totalBytes: 8,
        percent: 50,
        bytesPerSecond: expect.any(Number),
      },
      {
        uploadedBytes: 8,
        totalBytes: 8,
        percent: 100,
        bytesPerSecond: expect.any(Number),
      },
    ])
    expect(progressEvents.every((event) => event.bytesPerSecond > 0)).toBe(true)
  })

  it('creates the backend task and upload session before sending parts to R2', async () => {
    const api = createApi()
    const r2Fetch = vi.fn(async () => new Response(null, { headers: { ETag: '"etag-1"' } }))

    await uploadDocument({
      api,
      file: createPdfFile(4),
      r2Fetch,
    })

    expect(api.createTask).toHaveBeenCalledWith({
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: 4,
      turnstileToken: null,
      gaClientId: null,
    })
    expect(api.createUploadSession).toHaveBeenCalledWith('task_frontendupload12345678901234567890')
    expect(r2Fetch).toHaveBeenCalledWith(
      'https://r2.test/upload-part-1',
      expect.objectContaining({
        method: 'PUT',
      })
    )
    expect(api.completeUpload).toHaveBeenCalledWith('task_frontendupload12345678901234567890', 'upload_123', [
      {
        partNumber: 1,
        etag: '"etag-1"',
      },
    ])
  })

  it('requests a fresh Turnstile token before creating the backend task', async () => {
    const api = createApi()
    const r2Fetch = vi.fn(async () => new Response(null, { headers: { ETag: '"etag-1"' } }))
    const getTurnstileToken = vi.fn(async () => 'turnstile-token')
    const onVerificationStarted = vi.fn()

    await uploadDocument({
      api,
      file: createPdfFile(4),
      r2Fetch,
      getTurnstileToken,
      onVerificationStarted,
    })

    expect(onVerificationStarted).toHaveBeenCalledOnce()
    expect(onVerificationStarted.mock.invocationCallOrder[0]).toBeLessThan(getTurnstileToken.mock.invocationCallOrder[0])
    expect(getTurnstileToken).toHaveBeenCalledOnce()
    expect(api.createTask).toHaveBeenCalledWith({
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: 4,
      turnstileToken: 'turnstile-token',
      gaClientId: null,
    })
  })

  it('passes the GA client id into backend task creation when available', async () => {
    const api = createApi()
    const r2Fetch = vi.fn(async () => new Response(null, { headers: { ETag: '"etag-1"' } }))

    await uploadDocument({
      api,
      file: createPdfFile(4),
      r2Fetch,
      gaClientId: '12345.67890',
    })

    expect(api.createTask).toHaveBeenCalledWith({
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: 4,
      turnstileToken: null,
      gaClientId: '12345.67890',
    })
  })

  it('rejects unsupported file types before creating a backend task', async () => {
    const api = createApi()

    await expect(
      uploadDocument({
        api,
        file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
        r2Fetch: vi.fn(),
      })
    ).rejects.toThrow('Choose a PDF or EPUB file.')

    expect(api.createTask).not.toHaveBeenCalled()
  })

  it('retries a failed part without reuploading parts that already succeeded', async () => {
    const api = createApi({
      createUploadSession: vi.fn(async () => ({
        taskId: 'task_frontendupload12345678901234567890',
        uploadId: 'upload_123',
        status: 'pending',
        partSizeBytes: 4,
        partCount: 2,
        presignedUrlTtlSeconds: 900,
      })),
    })
    const r2Fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { headers: { ETag: '"etag-1"' } }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { headers: { ETag: '"etag-2"' } }))

    await uploadDocument({
      api,
      file: createPdfFile(8),
      r2Fetch,
      maxPartAttempts: 2,
    })

    expect(r2Fetch).toHaveBeenCalledTimes(3)
    expect(r2Fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://r2.test/upload-part-1',
      'https://r2.test/upload-part-2',
      'https://r2.test/upload-part-2',
    ])
    expect(api.completeUpload).toHaveBeenCalledWith('task_frontendupload12345678901234567890', 'upload_123', [
      {
        partNumber: 1,
        etag: '"etag-1"',
      },
      {
        partNumber: 2,
        etag: '"etag-2"',
      },
    ])
  })

  it('requests a fresh presigned URL when R2 reports an expired upload URL', async () => {
    const api = createApi({
      signUploadParts: vi
        .fn()
        .mockResolvedValueOnce({
          taskId: 'task_frontendupload12345678901234567890',
          uploadId: 'upload_123',
          parts: [{ partNumber: 1, url: 'https://r2.test/expired-part-1' }],
        })
        .mockResolvedValueOnce({
          taskId: 'task_frontendupload12345678901234567890',
          uploadId: 'upload_123',
          parts: [{ partNumber: 1, url: 'https://r2.test/fresh-part-1' }],
        }),
    })
    const r2Fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('expired', { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { headers: { ETag: '"etag-1"' } }))

    await uploadDocument({
      api,
      file: createPdfFile(4),
      r2Fetch,
      maxPartAttempts: 2,
    })

    expect(api.signUploadParts).toHaveBeenCalledTimes(2)
    expect(api.signUploadParts).toHaveBeenLastCalledWith(
      'task_frontendupload12345678901234567890',
      'upload_123',
      [1]
    )
    expect(r2Fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://r2.test/expired-part-1',
      'https://r2.test/fresh-part-1',
    ])
  })

  it('retries a part when the browser upload request rejects before any HTTP response', async () => {
    const api = createApi()
    const r2Fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(new Response(null, { headers: { ETag: '"etag-1"' } }))

    await uploadDocument({
      api,
      file: createPdfFile(4),
      r2Fetch,
      maxPartAttempts: 2,
    })

    expect(r2Fetch).toHaveBeenCalledTimes(2)
    expect(api.completeUpload).toHaveBeenCalledWith('task_frontendupload12345678901234567890', 'upload_123', [
      {
        partNumber: 1,
        etag: '"etag-1"',
      },
    ])
  })

  it('uses a host-bound default fetch for R2 uploads', async () => {
    const api = createApi()
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation')
      }

      return Promise.resolve(new Response(null, { headers: { ETag: '"etag-1"' } }))
    })

    vi.stubGlobal('fetch', fetchSpy)

    try {
      await uploadDocument({
        api,
        file: createPdfFile(4),
      })
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(api.completeUpload).toHaveBeenCalledWith('task_frontendupload12345678901234567890', 'upload_123', [
      {
        partNumber: 1,
        etag: '"etag-1"',
      },
    ])
  })

  it('aborts the backend upload session when the caller cancels', async () => {
    const api = createApi()
    const controller = new AbortController()
    const r2Fetch = vi.fn(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })

    await expect(
      uploadDocument({
        api,
        file: createPdfFile(4),
        r2Fetch,
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/i)

    expect(api.abortUpload).toHaveBeenCalledWith('task_frontendupload12345678901234567890', 'upload_123')
  })

  it('aborts the backend upload session when part upload fails after retries', async () => {
    const api = createApi()
    const r2Fetch = vi.fn(async () => new Response('temporary failure', { status: 500 }))

    await expect(
      uploadDocument({
        api,
        file: createPdfFile(4),
        r2Fetch,
        maxPartAttempts: 1,
      })
    ).rejects.toThrow('Upload failed for part 1.')

    expect(api.abortUpload).toHaveBeenCalledWith('task_frontendupload12345678901234567890', 'upload_123')
  })
})
