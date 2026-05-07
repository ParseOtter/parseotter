import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskResponse } from '../src/parseotter-api'

type MockFetchCall = {
  url: string
  init?: RequestInit
}

type TurnstileRenderOptions = {
  callback: (token: string) => void
}

const createdTask: TaskResponse = {
  taskId: 'task_turnstile1234567890123456789012',
  status: 'created',
  visibleStatus: 'Waiting for upload',
  version: 1,
  attempt: 0,
  createdAt: '2026-04-25T00:00:00.000Z',
  updatedAt: '2026-04-25T00:00:00.000Z',
  expiresAt: '2099-05-27T00:00:00.000Z',
  expiredAt: null,
  error: null,
  file: {
    name: 'sample.pdf',
    type: 'application/pdf',
    sizeBytes: 13,
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
}

function makeTask(input: { taskId: string; fileName: string; fileSizeBytes: number; status?: string; visibleStatus?: string }): TaskResponse {
  return {
    ...createdTask,
    taskId: input.taskId,
    status: input.status ?? createdTask.status,
    visibleStatus: input.visibleStatus ?? createdTask.visibleStatus,
    file: {
      ...createdTask.file,
      name: input.fileName,
      sizeBytes: input.fileSizeBytes,
    },
  }
}

function successJson(data: unknown, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      error: null,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      ...init,
    }
  )
}

function getMockTaskId(fileName: string): string {
  return `task_${fileName.replace(/[^a-z0-9]+/gi, '_')}`
}

function installUploadFetchMock(): { calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = []
  const fileNamesByTaskId = new Map<string, string>()
  const fileSizesByTaskId = new Map<string, number>()

  function findFileNameForTaskUrl(url: string): string {
    const taskId = Array.from(fileNamesByTaskId.keys()).find((candidate) => url.includes(`/api/tasks/${candidate}`))
    if (!taskId) {
      throw new Error(`Unexpected task URL: ${url}`)
    }

    return fileNamesByTaskId.get(taskId) ?? createdTask.file.name
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })

      if (url.endsWith('/api/tasks')) {
        const body = JSON.parse(String(init?.body)) as {
          fileName: string
          fileSizeBytes: number
        }
        const taskId = getMockTaskId(body.fileName)
        fileNamesByTaskId.set(taskId, body.fileName)
        fileSizesByTaskId.set(taskId, body.fileSizeBytes)

        return successJson(
          makeTask({
            taskId,
            fileName: body.fileName,
            fileSizeBytes: body.fileSizeBytes,
          }),
          { status: 201 }
        )
      }

      if (url.endsWith('/uploads')) {
        const fileName = findFileNameForTaskUrl(url)
        const taskId = getMockTaskId(fileName)

        return successJson(
          {
            taskId,
            uploadId: `upload_${taskId}`,
            status: 'pending',
            partSizeBytes: 5 * 1024 * 1024,
            partCount: 1,
            presignedUrlTtlSeconds: 900,
          },
          { status: 201 }
        )
      }

      if (url.includes('/uploads/') && url.endsWith('/parts/sign')) {
        const fileName = findFileNameForTaskUrl(url)
        const taskId = getMockTaskId(fileName)

        return successJson({
          taskId,
          uploadId: `upload_${taskId}`,
          parts: [
            {
              partNumber: 1,
              url: `https://r2.test/${taskId}/part-1`,
            },
          ],
        })
      }

      if (url.startsWith('https://r2.test/')) {
        return new Response(null, { headers: { ETag: '"etag-app-1"' } })
      }

      if (url.endsWith('/complete')) {
        const fileName = findFileNameForTaskUrl(url)
        const taskId = getMockTaskId(fileName)

        return successJson(
          makeTask({
            taskId,
            fileName,
            fileSizeBytes: fileSizesByTaskId.get(taskId) ?? 0,
            status: 'processing',
            visibleStatus: 'Converting',
          })
        )
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
  )

  return { calls }
}

function getTaskCreateCalls(calls: MockFetchCall[]): MockFetchCall[] {
  return calls.filter((call) => call.url === 'http://localhost:8787/api/tasks')
}

function getCreateTaskTokens(calls: MockFetchCall[]): Array<string | null> {
  return getTaskCreateCalls(calls).map((call) => {
    const body = JSON.parse(String(call.init?.body)) as { turnstileToken: string | null }
    return body.turnstileToken
  })
}

describe('ParseOtter Turnstile upload integration', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key')
    window.localStorage.clear()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'turnstile')
  })

  it('passes a separate Turnstile token for each concurrent file upload', async () => {
    let renderOptions: TurnstileRenderOptions | null = null
    let tokenSequence = 0
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: {
        render: vi.fn((_container: HTMLElement, options: TurnstileRenderOptions) => {
          renderOptions = options
          return 'widget-id'
        }),
        reset: vi.fn(),
        execute: vi.fn(() => {
          tokenSequence += 1
          window.setTimeout(() => {
            renderOptions?.callback(`turnstile-token-${tokenSequence}`)
          }, 0)
        }),
      },
    })
    const { calls } = installUploadFetchMock()
    const { default: App } = await import('../src/App')
    const user = userEvent.setup()

    render(<App />)

    await user.upload(screen.getByLabelText('Choose PDF or EPUB files'), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
    ])
    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(document.getElementById('cf-turnstile-api')).toBeInTheDocument()
    })
    document.getElementById('cf-turnstile-api')?.dispatchEvent(new Event('load'))

    await waitFor(() => {
      expect(getCreateTaskTokens(calls)).toEqual(['turnstile-token-1', 'turnstile-token-2'])
    })
  })
})
