import { describe, expect, it } from 'vitest'

import {
  applyTaskTransition,
  createFailureTransition,
  mapInternalStatusToVisibleStatus,
  type TaskSnapshot,
} from '../../src/app/tasks/task-status'

const now = '2026-04-25T00:00:00.000Z'

function createSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task_abcdefghijklmnopqrstuvwxyz123456',
    status: 'processing',
    visibleStatus: 'Converting',
    version: 3,
    attempt: 2,
    createdAt: now,
    updatedAt: now,
    expiresAt: '2026-04-27T00:00:00.000Z',
    expiredAt: null,
    errorCode: null,
    errorMessage: null,
    fileName: 'sample.pdf',
    fileType: 'application/pdf',
    fileSizeBytes: 1024,
    uploadId: null,
    uploadStatus: null,
    inputObjectKey: null,
    inputSizeBytes: null,
    inputEtag: null,
    inputContentType: null,
    inputPartCount: null,
    inputChecksumSha256: null,
    outputObjectKey: null,
    outputContentType: null,
    outputSizeBytes: null,
    dispatchStatus: null,
    dispatchAttempt: 0,
    dispatchIdempotencyKey: null,
    dispatchStartedAt: null,
    dispatchCompletedAt: null,
    lastCallbackIdempotencyKey: null,
    clientHash: null,
    clientUserAgent: null,
    clientIpHash: null,
    gaClientId: null,
    ...overrides,
  }
}

describe('task status mapping', () => {
  it('maps internal states to the fixed user-visible Chinese statuses', () => {
    expect(mapInternalStatusToVisibleStatus('created')).toBe('Waiting for upload')
    expect(mapInternalStatusToVisibleStatus('upload_pending')).toBe('Waiting for upload')
    expect(mapInternalStatusToVisibleStatus('uploading')).toBe('Uploading')
    expect(mapInternalStatusToVisibleStatus('upload_completed')).toBe('Upload complete')
    expect(mapInternalStatusToVisibleStatus('dispatch_pending')).toBe('Waiting for conversion')
    expect(mapInternalStatusToVisibleStatus('dispatching')).toBe('Converting')
    expect(mapInternalStatusToVisibleStatus('processing')).toBe('Converting')
    expect(mapInternalStatusToVisibleStatus('succeeded')).toBe('Conversion complete')
    expect(mapInternalStatusToVisibleStatus('failed')).toBe('Conversion failed')
    expect(mapInternalStatusToVisibleStatus('expired')).toBe('Expired')
  })

  it('maps upload and Modal failures to a failed terminal task while preserving error codes', () => {
    expect(createFailureTransition({ errorCode: 'UPLOAD_ABORTED', updatedAt: now })).toMatchObject({
      status: 'failed',
      visibleStatus: 'Conversion failed',
      errorCode: 'UPLOAD_ABORTED',
    })
    expect(createFailureTransition({ errorCode: 'MODAL_DISPATCH_FAILED', updatedAt: now })).toMatchObject({
      status: 'failed',
      visibleStatus: 'Conversion failed',
      errorCode: 'MODAL_DISPATCH_FAILED',
    })
  })

  it('prevents stale attempts and failure callbacks from overriding a successful terminal state', () => {
    const succeeded = createSnapshot({
      status: 'succeeded',
      visibleStatus: 'Conversion complete',
      version: 8,
      attempt: 3,
    })

    const result = applyTaskTransition(
      succeeded,
      createFailureTransition({
        attempt: 3,
        errorCode: 'MODAL_PROCESSING_FAILED',
        errorMessage: 'late failure',
        updatedAt: '2026-04-25T00:01:00.000Z',
      })
    )

    expect(result.applied).toBe(false)
    expect(result.snapshot).toEqual(succeeded)
  })

  it('uses version increments for accepted transitions and ignores older attempts', () => {
    const snapshot = createSnapshot({ status: 'dispatching', visibleStatus: 'Converting', version: 4, attempt: 2 })

    const stale = applyTaskTransition(snapshot, {
      status: 'processing',
      visibleStatus: 'Converting',
      attempt: 1,
      updatedAt: '2026-04-25T00:02:00.000Z',
    })

    expect(stale.applied).toBe(false)
    expect(stale.snapshot).toEqual(snapshot)

    const accepted = applyTaskTransition(snapshot, {
      status: 'processing',
      visibleStatus: 'Converting',
      attempt: 2,
      updatedAt: '2026-04-25T00:03:00.000Z',
    })

    expect(accepted.applied).toBe(true)
    expect(accepted.snapshot).toMatchObject({
      status: 'processing',
      version: 5,
      updatedAt: '2026-04-25T00:03:00.000Z',
    })
  })
})
