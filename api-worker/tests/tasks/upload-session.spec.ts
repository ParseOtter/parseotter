import { describe, expect, it } from 'vitest'

import {
  createDownloadArchiveFilename,
  createPresignedDownloadUrl,
  createCompletedUploadParts,
  createMultipartUploadPlan,
  presignUploadPartUrl,
  R2_MIN_MULTIPART_PART_SIZE_BYTES,
} from '../../src/app/tasks/upload-session'

describe('upload session signing', () => {
  it('creates a multipart plan that matches R2 part size and count constraints', () => {
    expect(createMultipartUploadPlan(R2_MIN_MULTIPART_PART_SIZE_BYTES + 1)).toEqual({
      partSizeBytes: R2_MIN_MULTIPART_PART_SIZE_BYTES,
      partCount: 2,
      lastPartSizeBytes: 1,
    })
  })

  it('rejects a multipart plan when non-final parts would be below the R2 minimum size', () => {
    expect(() => createMultipartUploadPlan(R2_MIN_MULTIPART_PART_SIZE_BYTES + 1, 1024 * 1024)).toThrow(
      'Multipart upload violates R2 multipart constraints'
    )
  })

  it('rejects a multipart plan when it would exceed the R2 maximum part count', () => {
    expect(() =>
      createMultipartUploadPlan(R2_MIN_MULTIPART_PART_SIZE_BYTES * 10_000 + 1)
    ).toThrow('Multipart upload violates R2 multipart constraints')
  })

  it('produces a fresh presigned URL when the same part is signed at a later time', async () => {
    const commonInput = {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      endpoint: 'https://example-account.r2.cloudflarestorage.com',
      bucket: 'parseotter-files-dev',
      key: 'parseotter/task_test/input/original.pdf',
      uploadId: 'upload-test-id',
      partNumber: 1,
      expiresInSeconds: 900,
    }

    const firstUrl = await presignUploadPartUrl({
      ...commonInput,
      now: new Date('2026-04-25T00:00:00.000Z'),
    })
    const secondUrl = await presignUploadPartUrl({
      ...commonInput,
      now: new Date('2026-04-25T00:10:00.000Z'),
    })

    expect(firstUrl).not.toBe(secondUrl)

    const first = new URL(firstUrl)
    const second = new URL(secondUrl)

    expect(first.searchParams.get('partNumber')).toBe('1')
    expect(second.searchParams.get('partNumber')).toBe('1')
    expect(first.searchParams.get('uploadId')).toBe('upload-test-id')
    expect(second.searchParams.get('uploadId')).toBe('upload-test-id')
    expect(first.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(second.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(first.searchParams.get('X-Amz-Date')).not.toBe(second.searchParams.get('X-Amz-Date'))
    expect(first.searchParams.get('X-Amz-Signature')).not.toBe(second.searchParams.get('X-Amz-Signature'))
  })

  it('normalizes quoted completed-upload etags before passing them to R2 completion', () => {
    expect(
      createCompletedUploadParts({
        parts: [
          {
            partNumber: 1,
            etag: '  "etag-1"  ',
          },
        ],
        fileSizeBytes: 1024,
      })
    ).toEqual([
      {
        partNumber: 1,
        etag: 'etag-1',
      },
    ])
  })

  it('preserves unquoted completed-upload etags', () => {
    expect(
      createCompletedUploadParts({
        parts: [
          {
            partNumber: 1,
            etag: 'etag-1',
          },
        ],
        fileSizeBytes: 1024,
      })
    ).toEqual([
      {
        partNumber: 1,
        etag: 'etag-1',
      },
    ])
  })

  it('formats zip downloads from the original file name', () => {
    expect(createDownloadArchiveFilename('learning-to-launch.pdf')).toBe('learning-to-launch_pdf_converted.zip')
    expect(createDownloadArchiveFilename('Building High-Performance Web APIs with FastAPI.epub')).toBe(
      'Building High-Performance Web APIs with FastAPI_epub_converted.zip'
    )
  })

  it('adds a download filename to the presigned result URL', async () => {
    const download = await createPresignedDownloadUrl({
      key: 'parseotter/task_test/output/result.zip',
      fileName: "Bob's Guide.pdf",
      env: {
        R2_ACCESS_KEY_ID: 'test-access-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        R2_S3_ENDPOINT: 'https://your-cloudflare-account-id.r2.cloudflarestorage.com',
        R2_BUCKET_NAME: 'parseotter-files-dev',
        DOWNLOAD_URL_TTL_SECONDS: '600',
      },
    })

    const url = new URL(download.url)

    expect(download.expiresInSeconds).toBe(600)
    expect(url.searchParams.get('response-content-disposition')).toContain("filename=\"Bob's Guide_pdf_converted.zip\"")
    expect(url.searchParams.get('response-content-disposition')).toContain(
      "filename*=UTF-8''Bob%27s%20Guide_pdf_converted.zip"
    )
  })
})
