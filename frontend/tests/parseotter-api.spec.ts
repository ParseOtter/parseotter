import { afterEach, describe, expect, it, vi } from 'vitest'

import { createParseOtterApiClient } from '../src/parseotter-api'

describe('ParseOtter API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses a host-bound default fetch for API requests', async () => {
    const fetchSpy = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation')
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: 'task_api_binding_check',
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
                sizeBytes: 4,
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
            },
            error: null,
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        )
      )
    })

    vi.stubGlobal('fetch', fetchSpy)
    const api = createParseOtterApiClient({
      baseUrl: 'https://convert.example.com',
    })

    const task = await api.getTask('task_api_binding_check')

    expect(task.taskId).toBe('task_api_binding_check')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://convert.example.com/api/tasks/task_api_binding_check',
      expect.objectContaining({
        method: 'GET',
      })
    )
  })

  it('submits feedback through the common API envelope', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              feedbackId: 'feedback_api12345678901234567890',
              receivedAt: '2026-05-01T00:00:00.000Z',
            },
            error: null,
          }),
          {
            status: 201,
            headers: {
              'content-type': 'application/json',
            },
          }
        )
      )
    )
    const api = createParseOtterApiClient({
      baseUrl: 'https://convert.example.com',
      fetcher: fetchSpy,
    })

    await expect(
      api.submitFeedback({
        category: 'performance',
        rating: 4,
        message: 'Large PDFs feel slow after upload.',
        contact: 'ray@example.com',
        pageUrl: 'https://convert.example.com/',
        companyName: '',
      })
    ).resolves.toEqual({
      feedbackId: 'feedback_api12345678901234567890',
      receivedAt: '2026-05-01T00:00:00.000Z',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://convert.example.com/api/feedback',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          category: 'performance',
          rating: 4,
          message: 'Large PDFs feel slow after upload.',
          contact: 'ray@example.com',
          pageUrl: 'https://convert.example.com/',
          companyName: '',
        }),
      })
    )
  })

  it('sends Turnstile tokens with task creation requests when provided', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              taskId: 'task_turnstile_token_check',
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
                sizeBytes: 4,
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
            },
            error: null,
          }),
          {
            status: 201,
            headers: {
              'content-type': 'application/json',
            },
          }
        )
      )
    )
    const api = createParseOtterApiClient({
      baseUrl: 'https://convert.example.com',
      fetcher: fetchSpy,
    })

    await api.createTask({
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: 4,
      turnstileToken: 'turnstile-token',
      gaClientId: '12345.67890',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://convert.example.com/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          fileName: 'sample.pdf',
          fileType: 'application/pdf',
          fileSizeBytes: 4,
          turnstileToken: 'turnstile-token',
          gaClientId: '12345.67890',
        }),
      })
    )
  })
})
