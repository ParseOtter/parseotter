import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../src/App'
import type { TaskResponse } from '../src/parseotter-api'
import { PARSEOTTER_TASKS_STORAGE_KEY } from '../src/task-storage'

type MockFetchCall = {
  url: string
  init?: RequestInit
}

const createdTask: TaskResponse = {
  taskId: 'task_frontendapp1234567890123456789012',
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

function makeTask(
  input: Partial<typeof createdTask> & {
    taskId: string
    fileName?: string
    fileSizeBytes?: number
    outputSizeBytes?: number | null
    dispatchStartedAt?: string | null
    dispatchCompletedAt?: string | null
  }
): TaskResponse {
  return {
    ...createdTask,
    ...input,
    file: {
      ...createdTask.file,
      ...input.file,
      name: input.fileName ?? input.file?.name ?? createdTask.file.name,
      sizeBytes: input.fileSizeBytes ?? input.file?.sizeBytes ?? createdTask.file.sizeBytes,
    },
    output: {
      ...createdTask.output,
      ...input.output,
      sizeBytes: input.outputSizeBytes ?? input.output?.sizeBytes ?? createdTask.output.sizeBytes,
    },
    dispatch: {
      ...createdTask.dispatch,
      ...input.dispatch,
      startedAt: input.dispatchStartedAt ?? input.dispatch?.startedAt ?? createdTask.dispatch.startedAt,
      completedAt: input.dispatchCompletedAt ?? input.dispatch?.completedAt ?? createdTask.dispatch.completedAt,
    },
  }
}

type MockCompletedTask = Partial<Omit<TaskResponse, 'output'>> & {
  output?: {
    objectKey?: string | null
    contentType?: string | null
    sizeBytes?: number | null
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

function errorJson(error: { code: string; message: string; details?: unknown }, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify({
      success: false,
      data: null,
      error,
    }),
    {
      status: 400,
      headers: {
        'content-type': 'application/json',
      },
      ...init,
    }
  )
}

function installUploadFetchMock(input?: { completedTask?: MockCompletedTask }): {
  calls: MockFetchCall[]
} {
  const calls: MockFetchCall[] = []
  const completedTaskOverrides = input?.completedTask ?? {}
  const completedTask = {
    ...createdTask,
    ...completedTaskOverrides,
    status: completedTaskOverrides.status ?? 'processing',
    visibleStatus: completedTaskOverrides.visibleStatus ?? 'Converting',
    version: completedTaskOverrides.version ?? 2,
    upload: {
      ...createdTask.upload,
      ...completedTaskOverrides.upload,
      uploadId: 'upload_app_123',
      status: 'completed',
      inputPartCount: 1,
    },
    output: {
      ...createdTask.output,
      ...completedTaskOverrides.output,
    },
    dispatch: {
      ...createdTask.dispatch,
      ...completedTaskOverrides.dispatch,
      status: 'dispatched',
      attempt: 1,
    },
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })

      if (url.endsWith('/api/tasks')) {
        return successJson(createdTask, { status: 201 })
      }

      if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads`)) {
        return successJson(
          {
            taskId: createdTask.taskId,
            uploadId: 'upload_app_123',
            status: 'pending',
            partSizeBytes: 5 * 1024 * 1024,
            partCount: 1,
            presignedUrlTtlSeconds: 900,
          },
          { status: 201 }
        )
      }

      if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads/upload_app_123/parts/sign`)) {
        return successJson({
          taskId: createdTask.taskId,
          uploadId: 'upload_app_123',
          parts: [
            {
              partNumber: 1,
              url: 'https://r2.test/upload-app-part-1',
            },
          ],
        })
      }

      if (url === 'https://r2.test/upload-app-part-1') {
        return new Response(null, { headers: { ETag: '"etag-app-1"' } })
      }

      if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads/upload_app_123/complete`)) {
        return successJson(completedTask)
      }

      if (url.endsWith(`/api/tasks/${createdTask.taskId}`)) {
        return successJson({
          ...createdTask,
          status: 'processing',
          visibleStatus: 'Converting',
          upload: {
            ...createdTask.upload,
            uploadId: 'upload_app_123',
            status: 'completed',
          },
          dispatch: {
            ...createdTask.dispatch,
            status: 'dispatched',
            attempt: 1,
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
  )

  return { calls }
}

type DeferredUpload = {
  promise: Promise<Response>
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

function createDeferredUpload(signal?: AbortSignal): DeferredUpload {
  let cleanup = () => {}
  let resolveUpload: (response: Response) => void = () => {}
  let rejectUpload: (error: unknown) => void = () => {}
  const promise = new Promise<Response>((resolve, reject) => {
    resolveUpload = resolve
    rejectUpload = reject
    const abortUpload = () => {
      reject(new DOMException('Upload aborted', 'AbortError'))
    }

    if (signal?.aborted) {
      abortUpload()
      return
    }

    signal?.addEventListener('abort', abortUpload, { once: true })
    cleanup = () => signal?.removeEventListener('abort', abortUpload)
  })

  return {
    promise,
    resolve: (response) => {
      cleanup()
      resolveUpload(response)
    },
    reject: (error) => {
      cleanup()
      rejectUpload(error)
    },
  }
}

function getMockTaskId(fileName: string): string {
  return `task_${fileName.replace(/[^a-z0-9]+/gi, '_')}`
}

function installQueuedUploadFetchMock(input?: { failedUploadSessionFileNames?: string[] }): {
  calls: MockFetchCall[]
  resolveR2Upload: (fileName: string) => void
  rejectR2Upload: (fileName: string, error: unknown) => void
} {
  const calls: MockFetchCall[] = []
  const uploadsByFileName = new Map<string, DeferredUpload>()
  const fileNamesByTaskId = new Map<string, string>()
  const failedUploadSessionFileNames = new Set(input?.failedUploadSessionFileNames ?? [])

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

        return successJson(
          makeTask({
            taskId,
            fileName: body.fileName,
            fileSizeBytes: body.fileSizeBytes,
            status: 'created',
            visibleStatus: 'Waiting for upload',
          }),
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

      if (url.endsWith('/uploads')) {
        const fileName = findFileNameForTaskUrl(url)
        const taskId = getMockTaskId(fileName)
        if (failedUploadSessionFileNames.has(fileName)) {
          return errorJson(
            {
              code: 'UPLOAD_SESSION_FAILED',
              message: 'Unable to create upload session.',
            },
            { status: 500 }
          )
        }

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

      if (url.startsWith('https://r2.test/')) {
        const taskId = url.split('/')[3]
        const fileName = fileNamesByTaskId.get(taskId)
        if (!fileName) {
          throw new Error(`Unexpected R2 upload URL: ${url}`)
        }

        const deferredUpload = createDeferredUpload(init?.signal instanceof AbortSignal ? init.signal : undefined)
        uploadsByFileName.set(fileName, deferredUpload)
        return deferredUpload.promise
      }

      if (url.endsWith('/abort')) {
        const fileName = findFileNameForTaskUrl(url)

        return successJson(
          makeTask({
            taskId: getMockTaskId(fileName),
            fileName,
            status: 'failed',
            visibleStatus: 'Conversion failed',
            error: {
              code: 'UPLOAD_ABORTED',
              message: 'Upload canceled.',
            },
          })
        )
      }

      if (url.endsWith('/complete')) {
        const fileName = findFileNameForTaskUrl(url)

        return successJson(
          makeTask({
            taskId: getMockTaskId(fileName),
            fileName,
            status: 'processing',
            visibleStatus: 'Converting',
            upload: {
              ...createdTask.upload,
              uploadId: `upload_${getMockTaskId(fileName)}`,
              status: 'completed',
              inputPartCount: 1,
            },
            dispatch: {
              ...createdTask.dispatch,
              status: 'dispatched',
              attempt: 1,
            },
          })
        )
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
  )

  return {
    calls,
    resolveR2Upload: (fileName) => {
      const upload = uploadsByFileName.get(fileName)
      if (!upload) {
        throw new Error(`No pending upload for ${fileName}`)
      }

      upload.resolve(new Response(null, { headers: { ETag: `"etag-${fileName}"` } }))
    },
    rejectR2Upload: (fileName, error) => {
      const upload = uploadsByFileName.get(fileName)
      if (!upload) {
        throw new Error(`No pending upload for ${fileName}`)
      }

      upload.reject(error)
    },
  }
}

function getFileInput(): HTMLInputElement {
  return screen.getByLabelText('Choose PDF or EPUB files') as HTMLInputElement
}

function getUploadZone(): HTMLElement {
  return screen.getByRole('group', { name: 'Upload PDF or EPUB files' })
}

function getTaskCreateCalls(calls: MockFetchCall[]): MockFetchCall[] {
  return calls.filter((call) => call.url === 'http://localhost:8787/api/tasks')
}

function getTaskCreateFileNames(calls: MockFetchCall[]): string[] {
  return getTaskCreateCalls(calls).map((call) => {
    const body = JSON.parse(String(call.init?.body)) as { fileName: string }
    return body.fileName
  })
}

function installManualPolling(): {
  runLatestPoll: () => Promise<void>
} {
  const callbacks: Array<() => void> = []
  const manualIntervalIds = new Set<number>()
  const originalSetInterval = window.setInterval.bind(window)
  const originalClearInterval = window.clearInterval.bind(window)
  vi.spyOn(window, 'setInterval').mockImplementation((handler: TimerHandler, timeout?: number) => {
    if (timeout === 5000 && typeof handler === 'function') {
      callbacks.push(handler as () => void)
      const intervalId = callbacks.length
      manualIntervalIds.add(intervalId)
      return intervalId
    }

    return originalSetInterval(handler, timeout)
  })
  vi.spyOn(window, 'clearInterval').mockImplementation((intervalId) => {
    if (typeof intervalId === 'number' && manualIntervalIds.has(intervalId)) {
      manualIntervalIds.delete(intervalId)
      return
    }

    originalClearInterval(intervalId)
  })

  return {
    runLatestPoll: async () => {
      const callback = callbacks[callbacks.length - 1]
      if (!callback) {
        throw new Error('No polling interval was registered')
      }

      await act(async () => {
        callback()
        await Promise.resolve()
      })
    },
  }
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ParseOtter front page', () => {
  it('renders the upload entry point as the primary workflow', () => {
    render(<App />)

    expect(screen.getByRole('banner')).toHaveTextContent('ParseOtter')
    expect(screen.getByRole('banner')).toHaveTextContent('Convert')
    expect(screen.getByRole('button', { name: 'Feedback' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).not.toHaveTextContent('Free Beta')
    expect(screen.getByRole('heading', { name: 'Convert PDF or EPUB to Markdown' })).toBeInTheDocument()
    expect(screen.getByText('Prepare PDFs and EPUBs for AI, documentation, or knowledge-base workflows.')).toBeInTheDocument()
    expect(screen.getByText('Get clean Markdown and extracted images as a ZIP download.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose Files' })).toBeInTheDocument()
    expect(screen.getByText('Drag and drop files here')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Conversion Checklist' })).not.toBeInTheDocument()
    expect(document.querySelector('.upload-progress')).not.toBeInTheDocument()
  })

  it('renders the upload entry point when localStorage reads are blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage is blocked')
    })

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Convert PDF or EPUB to Markdown' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose Files' })).toBeInTheDocument()
  })

  it('submits user feedback from the header dialog', async () => {
    const user = userEvent.setup()
    const calls: MockFetchCall[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })

        if (url.endsWith('/api/feedback')) {
          return successJson(
            {
              feedbackId: 'feedback_frontend123456789012345',
              receivedAt: '2026-05-01T00:00:00.000Z',
            },
            { status: 201 }
          )
        }

        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Feedback' }))
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Topic'), 'performance')
    await user.click(screen.getByRole('radio', { name: '4' }))
    await user.type(screen.getByLabelText('Message'), 'Large PDFs feel slow after upload.')
    await user.type(screen.getByLabelText('Contact (optional)'), 'ray@example.com')
    await user.click(screen.getByRole('button', { name: 'Send feedback' }))

    expect(await screen.findByText('Feedback received.')).toBeInTheDocument()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'http://localhost:8787/api/feedback',
      init: {
        method: 'POST',
      },
    })
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      category: 'performance',
      rating: 4,
      message: 'Large PDFs feel slow after upload.',
      contact: 'ray@example.com',
      companyName: '',
    })
  })

  it('does not show stale feedback success after closing while submit is pending', async () => {
    const user = userEvent.setup()
    let resolveFeedback: (response: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/feedback')) {
          return new Promise<Response>((resolve) => {
            resolveFeedback = resolve
          })
        }

        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Feedback' }))
    await user.type(screen.getByLabelText('Message'), 'This conversion feedback is pending.')
    await user.click(screen.getByRole('button', { name: 'Send feedback' }))
    await user.click(screen.getByRole('button', { name: 'Close feedback' }))

    await act(async () => {
      resolveFeedback(
        successJson(
          {
            feedbackId: 'feedback_delayed123456789012345',
            receivedAt: '2026-05-01T00:00:00.000Z',
          },
          { status: 201 }
        )
      )
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: 'Feedback' }))
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument()
    expect(screen.queryByText('Feedback received.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('shows the frozen free conversion constraints', () => {
    render(<App />)

    expect(screen.getByText('Supported Formats')).toBeInTheDocument()
    expect(screen.getByText('PDF, EPUB')).toBeInTheDocument()
    expect(screen.getByText('Size limit')).toBeInTheDocument()
    expect(screen.getByText('Up to 100 MB per file')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText('Markdown')).toBeInTheDocument()
    expect(
      screen.getByText('Files are kept for up to 48 hours, then automatically deleted. Only this browser can see this list.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Free to use at parseotter.com, open source on GitHub, and self-hostable for private workflows.')
    ).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Copyright 2026 ParseOtter. Open source under AGPL-3.0.')
  })

  it('keeps only GitHub and feedback in the header while exposing footer trust links', async () => {
    const user = userEvent.setup()

    render(<App />)

    const header = within(screen.getByRole('banner'))
    const footer = within(screen.getByRole('contentinfo'))

    expect(header.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/ParseOtter/parseotter')
    expect(header.getByRole('button', { name: 'Feedback' })).toBeInTheDocument()
    expect(header.queryByRole('link', { name: 'Self-host' })).not.toBeInTheDocument()
    expect(header.queryByRole('button', { name: 'Privacy' })).not.toBeInTheDocument()
    expect(header.queryByRole('button', { name: 'Examples' })).not.toBeInTheDocument()

    expect(footer.getByRole('link', { name: 'Self-host' })).toHaveAttribute(
      'href',
      'https://github.com/ParseOtter/parseotter/blob/main/DEPLOYMENT.md'
    )

    await user.click(footer.getByRole('button', { name: 'Privacy' }))
    expect(screen.getByRole('dialog', { name: 'ParseOtter privacy information' })).toBeInTheDocument()
    expect(screen.getByText('Privacy and retention')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Self-hosting guide' })).toHaveAttribute(
      'href',
      'https://github.com/ParseOtter/parseotter/blob/main/DEPLOYMENT.md'
    )
  })

  it('does not render the old conversion checklist', () => {
    render(<App />)

    expect(screen.queryByRole('complementary', { name: 'Conversion Checklist' })).not.toBeInTheDocument()
    expect(screen.queryByText('Conversion Checklist')).not.toBeInTheDocument()
    expect(screen.queryByText('Select file')).not.toBeInTheDocument()
  })

  it('uses an empty Files state instead of seeded conversion data', () => {
    render(<App />)

    expect(screen.queryByText('No file selected yet')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Files' })).toBeInTheDocument()
    expect(screen.getByText('Local history · kept on this device for 48 hours')).toBeInTheDocument()
    expect(screen.getByText('Your recent conversions will appear here for 48 hours on this device.')).toBeInTheDocument()
    expect(screen.queryByText('annual_report_draft_v2.pdf')).not.toBeInTheDocument()
    expect(screen.queryByText('user_manual_final.pdf')).not.toBeInTheDocument()
  })

  it('keeps excluded product surfaces out of the free tool', () => {
    render(<App />)

    const page = within(screen.getByRole('main'))
    expect(page.queryByText(/login/i)).not.toBeInTheDocument()
    expect(page.queryByText(/pricing/i)).not.toBeInTheDocument()
    expect(page.queryByText(/credits/i)).not.toBeInTheDocument()
    expect(page.queryByText(/subscription/i)).not.toBeInTheDocument()
    expect(page.queryByText(/translation/i)).not.toBeInTheDocument()
    expect(page.queryByText(/conversion history/i)).not.toBeInTheDocument()
  })

  it('keeps the upload entry point unchanged after files are selected', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    const uploadZone = getUploadZone()
    expect(within(uploadZone).getByText('Drag and drop files here')).toBeInTheDocument()
    expect(within(uploadZone).getByRole('button', { name: 'Choose Files' })).toBeInTheDocument()

    const selectedFiles = screen.getByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('sample.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('Ready')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not create backend tasks when files are only selected', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['%PDF-1.7 body'], 'first.pdf', { type: 'application/pdf' }),
      new File(['epub'], 'second.epub', { type: 'application/epub+zip' }),
    ])

    expect(screen.getByRole('region', { name: 'Selected files' })).toBeInTheDocument()
    expect(screen.getByText('first.pdf')).toBeInTheDocument()
    expect(screen.getByText('second.epub')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalledWith('http://localhost:8787/api/tasks', expect.anything())
  })

  it('treats same-name same-size selected files as duplicates even when contents differ', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['aaaa'], 'revised.pdf', { type: 'application/pdf' }),
      new File(['bbbb'], 'revised.pdf', { type: 'application/pdf' }),
    ])

    const selectedFiles = screen.getByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getAllByText('revised.pdf')).toHaveLength(2)
    expect(within(selectedFiles).getByText('Ready')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('Duplicate in selection')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('creates backend tasks only after Start processing is clicked', async () => {
    const user = userEvent.setup()
    const { calls } = installUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    expect(getTaskCreateCalls(calls)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateCalls(calls)).toHaveLength(1)
    })
  })

  it('lists duplicate, unsupported, and oversized files in Selected files with reasons', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const oversizedFile = new File(['small bytes'], 'oversized.pdf', {
      type: 'application/pdf',
    })
    Object.defineProperty(oversizedFile, 'size', {
      value: 100 * 1024 * 1024 + 1,
    })

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['ready'], 'ready.pdf', { type: 'application/pdf' }),
      new File(['same'], 'duplicate.pdf', { type: 'application/pdf' }),
      new File(['same'], 'duplicate.pdf', { type: 'application/pdf' }),
      new File(['plain text'], 'notes.txt', { type: 'text/plain' }),
      oversizedFile,
    ])

    const selectedFiles = screen.getByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('ready.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getAllByText('duplicate.pdf')).toHaveLength(2)
    expect(within(selectedFiles).getByText('notes.txt')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('oversized.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getAllByText('Ready')).toHaveLength(2)
    expect(within(selectedFiles).getByText('Duplicate in selection')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('Choose a PDF or EPUB file.')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('File must be 100 MB or smaller.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start processing' })).toBeEnabled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uploads selected PDFs through the backend session and R2 presigned URL flow after confirmation', async () => {
    const user = userEvent.setup()
    const { calls } = installUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    expect(getTaskCreateCalls(calls)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(screen.getAllByText('Building ZIP output').length).toBeGreaterThan(0)
    })

    expect(screen.getAllByText('sample.pdf').length).toBeGreaterThan(0)
    expect(within(getUploadZone()).getByText('Drag and drop files here')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: 'Conversion progress' })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Conversion Checklist' })).not.toBeInTheDocument()
    expect(document.querySelector('.upload-progress')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Processing' })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Processing tasks' })).getByText('Building ZIP output')).toBeInTheDocument()
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:8787/api/tasks',
      `http://localhost:8787/api/tasks/${createdTask.taskId}/uploads`,
      `http://localhost:8787/api/tasks/${createdTask.taskId}/uploads/upload_app_123/parts/sign`,
      'https://r2.test/upload-app-part-1',
      `http://localhost:8787/api/tasks/${createdTask.taskId}/uploads/upload_app_123/complete`,
    ])
    expect(JSON.parse(window.localStorage.getItem(PARSEOTTER_TASKS_STORAGE_KEY) ?? '[]')).toMatchObject([
      {
        taskId: createdTask.taskId,
        fileName: 'sample.pdf',
        createdAt: '2026-04-25T00:00:00.000Z',
        expiresAt: '2099-05-27T00:00:00.000Z',
        fileSizeBytes: 13,
      },
    ])
  })

  it('uploads selected files when localStorage persistence is blocked', async () => {
    const user = userEvent.setup()
    const { calls } = installUploadFetchMock()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage is blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage is full')
    })

    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))
    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateCalls(calls)).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.getAllByText('Building ZIP output').length).toBeGreaterThan(0)
    })
  })

  it('starts at most two file uploads and keeps later files waiting', async () => {
    const user = userEvent.setup()
    const { calls } = installQueuedUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf'])
    })

    const uploadingGroup = screen.getByRole('group', { name: 'Uploading tasks' })
    expect(within(uploadingGroup).getByText('first.pdf')).toBeInTheDocument()
    expect(within(uploadingGroup).getByText('second.pdf')).toBeInTheDocument()
    expect(within(uploadingGroup).getByText('third.pdf')).toBeInTheDocument()
    expect(within(uploadingGroup).getByText('Waiting to upload')).toBeInTheDocument()
  })

  it('starts the next waiting file when an active upload finishes', async () => {
    const user = userEvent.setup()
    const { calls, resolveR2Upload } = installQueuedUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf'])
    })

    resolveR2Upload('first.pdf')

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf', 'third.pdf'])
    })
  })

  it('removes a waiting upload without creating a backend task for it', async () => {
    const user = userEvent.setup()
    const { calls, resolveR2Upload } = installQueuedUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf'])
    })

    await user.click(screen.getByRole('button', { name: 'Cancel upload for third.pdf' }))
    resolveR2Upload('first.pdf')

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Processing' })).toBeInTheDocument()
    })
    expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf'])
    expect(screen.queryByText('third.pdf')).not.toBeInTheDocument()
  })

  it('cancels one active upload without stopping other files in the queue', async () => {
    const user = userEvent.setup()
    const { calls } = installQueuedUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf'])
    })

    await user.click(screen.getByRole('button', { name: 'Cancel upload for first.pdf' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf', 'third.pdf'])
    })
    expect(screen.getByText('second.pdf')).toBeInTheDocument()
  })

  it('starts the next waiting file when one active upload fails', async () => {
    const user = userEvent.setup()
    const { calls } = installQueuedUploadFetchMock({
      failedUploadSessionFileNames: ['first.pdf'],
    })

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf', 'third.pdf'])
    })
    const failedGroup = await screen.findByRole('group', { name: 'Failed tasks' })
    expect(within(failedGroup).getByText('first.pdf')).toBeInTheDocument()
    expect(within(failedGroup).getByText('Unable to create upload session.')).toBeInTheDocument()
    expect(screen.getByText('second.pdf')).toBeInTheDocument()
    expect(screen.getByText('third.pdf')).toBeInTheDocument()
  })

  it('keeps oversized files in Selected files before calling the backend', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const oversizedFile = new File(['small bytes'], 'oversized.pdf', {
      type: 'application/pdf',
    })
    Object.defineProperty(oversizedFile, 'size', {
      value: 100 * 1024 * 1024 + 1,
    })

    render(<App />)

    await user.upload(getFileInput(), oversizedFile)

    const selectedFiles = await screen.findByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('oversized.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('Invalid')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('File must be 100 MB or smaller.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start processing' })).toBeDisabled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('restores locally saved tasks and refreshes their status on page load', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        successJson({
          ...createdTask,
          status: 'processing',
          visibleStatus: 'Converting',
        })
      )
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('sample.pdf')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Processing' })).toBeInTheDocument()
      expect(screen.getByText(/Uploaded 13 B · Apr 25, 2026, \d{2}:\d{2}:\d{2}/)).toBeInTheDocument()
    })
    const processingGroup = screen.getByRole('group', { name: 'Processing tasks' })
    expect(within(processingGroup).getByText('Building ZIP output')).toBeInTheDocument()
    expect(within(processingGroup).getByRole('progressbar', { name: 'Processing progress for sample.pdf' })).toBeInTheDocument()
    expect(within(processingGroup).queryByText(/Result pending/)).not.toBeInTheDocument()
    const taskRow = screen.getByText('sample.pdf').closest('.task-row')
    expect(taskRow?.querySelector('.document-identity-pdf')).toBeInTheDocument()
    expect(taskRow?.querySelector('.document-identity-state-live')).toBeInTheDocument()
  })

  it('keeps a processing task active after a transient network refresh failure and recovers on the next poll', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    const polling = installManualPolling()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          successJson({
            ...createdTask,
            status: 'processing',
            visibleStatus: 'Converting',
          })
        )
        .mockRejectedValueOnce(new Error('Network unavailable'))
        .mockResolvedValueOnce(
          successJson({
            ...createdTask,
            status: 'succeeded',
            visibleStatus: 'Conversion complete',
            output: {
              ...createdTask.output,
              sizeBytes: 2048,
            },
          })
        )
    )

    render(<App />)

    expect(await screen.findByRole('group', { name: 'Processing tasks' })).toHaveTextContent('sample.pdf')

    await polling.runLatestPoll()

    await waitFor(() => {
      const processingGroup = screen.getByRole('group', { name: 'Processing tasks' })
      expect(within(processingGroup).getByText('sample.pdf')).toBeInTheDocument()
      expect(within(processingGroup).getByText('Network unavailable')).toBeInTheDocument()
    })
    expect(screen.queryByRole('group', { name: 'Failed tasks' })).not.toBeInTheDocument()

    await polling.runLatestPoll()

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Results tasks' })).toHaveTextContent('sample.pdf')
    })
  })

  it('keeps polling after a transient 503 refresh response', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    const polling = installManualPolling()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          successJson({
            ...createdTask,
            status: 'processing',
            visibleStatus: 'Converting',
          })
        )
        .mockResolvedValueOnce(
          errorJson(
            {
              code: 'REQUEST_FAILED',
              message: 'Temporary service failure',
            },
            { status: 503 }
          )
        )
        .mockResolvedValueOnce(
          successJson({
            ...createdTask,
            status: 'succeeded',
            visibleStatus: 'Conversion complete',
          })
        )
    )

    render(<App />)

    expect(await screen.findByRole('group', { name: 'Processing tasks' })).toHaveTextContent('sample.pdf')

    await polling.runLatestPoll()

    await waitFor(() => {
      const processingGroup = screen.getByRole('group', { name: 'Processing tasks' })
      expect(within(processingGroup).getByText('sample.pdf')).toBeInTheDocument()
      expect(within(processingGroup).getByText('Temporary service failure')).toBeInTheDocument()
    })
    expect(screen.queryByRole('group', { name: 'Failed tasks' })).not.toBeInTheDocument()

    await polling.runLatestPoll()

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Results tasks' })).toHaveTextContent('sample.pdf')
    })
  })

  it('shows waiting-for-conversion tasks without ZIP-build copy', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        successJson({
          ...createdTask,
          status: 'dispatch_pending',
          visibleStatus: 'Waiting for conversion',
          upload: {
            ...createdTask.upload,
            uploadId: 'upload_app_123',
            status: 'completed',
          },
          dispatch: {
            ...createdTask.dispatch,
            status: 'pending',
            attempt: 1,
            startedAt: '2026-04-25T00:03:00.000Z',
          },
        })
      )
    )

    render(<App />)

    const processingGroup = await screen.findByRole('group', { name: 'Processing tasks' })
    expect(within(processingGroup).getByText('sample.pdf')).toBeInTheDocument()
    expect(within(processingGroup).getByText('Waiting for conversion')).toBeInTheDocument()
    expect(within(processingGroup).queryByText('Building ZIP output')).not.toBeInTheDocument()
  })

  it('removes restored tasks that never finished uploading after the page reloads', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        successJson({
          ...createdTask,
          status: 'upload_pending',
          visibleStatus: 'Waiting for upload',
        })
      )
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.queryByText('sample.pdf')).not.toBeInTheDocument()
    })

    expect(screen.queryByRole('heading', { name: 'Uploading' })).not.toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(PARSEOTTER_TASKS_STORAGE_KEY) ?? '[]')).toEqual([])
  })

  it('shows recent task zip size when the backend reports an output archive', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        successJson({
          ...createdTask,
          status: 'succeeded',
          visibleStatus: 'Conversion complete',
          output: {
            ...createdTask.output,
            sizeBytes: 2048,
          },
        })
      )
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('sample.pdf')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Results' })).toBeInTheDocument()
      expect(screen.getByText(/Uploaded 13 B · Apr 25, 2026, \d{2}:\d{2}:\d{2}/)).toBeInTheDocument()
      expect(screen.getByText(/Result 2.00 KB · Apr 25, 2026, \d{2}:\d{2}:\d{2}/)).toBeInTheDocument()
    })
  })

  it('groups recent tasks by status and keeps each group sorted by upload time', async () => {
    const tasks = [
      makeTask({
        taskId: 'task_processing_old',
        fileName: 'processing-old.pdf',
        status: 'processing',
        visibleStatus: 'Converting',
        createdAt: '2026-04-25T00:00:00.000Z',
        updatedAt: '2026-04-25T00:03:00.000Z',
        dispatchStartedAt: '2026-04-25T00:03:00.000Z',
      }),
      makeTask({
        taskId: 'task_processing_new',
        fileName: 'processing-new.pdf',
        status: 'dispatching',
        visibleStatus: 'Converting',
        createdAt: '2026-04-25T01:00:00.000Z',
        updatedAt: '2026-04-25T01:03:00.000Z',
        dispatchStartedAt: '2026-04-25T01:03:00.000Z',
      }),
      makeTask({
        taskId: 'task_succeeded',
        fileName: 'done.pdf',
        status: 'succeeded',
        visibleStatus: 'Conversion complete',
        createdAt: '2026-04-24T23:00:00.000Z',
        updatedAt: '2026-04-24T23:04:00.000Z',
        outputSizeBytes: 4096,
        dispatchStartedAt: '2026-04-24T23:02:00.000Z',
        dispatchCompletedAt: '2026-04-24T23:04:00.000Z',
      }),
      makeTask({
        taskId: 'task_expired',
        fileName: 'expired.pdf',
        status: 'expired',
        visibleStatus: 'Expired',
        createdAt: '2026-04-23T23:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
        expiredAt: '2026-04-26T00:00:00.000Z',
        error: {
          code: 'TASK_EXPIRED',
          message: 'Expired',
        },
      }),
    ]
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify(
        tasks.map((task) => ({
          taskId: task.taskId,
          fileName: task.file.name,
          createdAt: task.createdAt,
          expiresAt: task.expiresAt,
          fileSizeBytes: task.file.sizeBytes,
        }))
      )
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const task = tasks.find((item) => String(input).endsWith(`/api/tasks/${item.taskId}`))
        if (!task) {
          throw new Error(`Unexpected fetch: ${String(input)}`)
        }

        return successJson(task)
      })
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('processing-new.pdf')).toBeInTheDocument()
    })
    const groupHeadings = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
      .filter((text) => ['Processing', 'Results', 'Expired'].includes(text ?? ''))
    expect(groupHeadings).toEqual(['Processing', 'Results', 'Expired'])

    const processingGroup = screen.getByRole('group', { name: 'Processing tasks' })
    const processingRows = within(processingGroup).getAllByText(/processing-.+\.pdf/).map((item) => item.textContent)
    expect(processingRows).toEqual(['processing-new.pdf', 'processing-old.pdf'])
  })

  it('shows processing tasks with row-level progress instead of pending result text', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        successJson({
          ...createdTask,
          status: 'processing',
          visibleStatus: 'Converting',
          upload: {
            ...createdTask.upload,
            uploadId: 'upload_app_123',
            status: 'completed',
          },
          dispatch: {
            ...createdTask.dispatch,
            status: 'dispatched',
            attempt: 1,
            startedAt: '2026-04-25T00:03:00.000Z',
          },
        })
      )
    )

    render(<App />)

    const processingGroup = await screen.findByRole('group', { name: 'Processing tasks' })
    expect(within(processingGroup).getByText('sample.pdf')).toBeInTheDocument()
    expect(within(processingGroup).getByText('Building ZIP output')).toBeInTheDocument()
    expect(
      within(processingGroup).getByRole('progressbar', {
        name: 'Processing progress for sample.pdf',
      })
    ).toBeInTheDocument()
    expect(within(processingGroup).queryByText(/Result pending/)).not.toBeInTheDocument()
  })

  it('shows failed and expired task reasons without result prefix copy', async () => {
    const tasks = [
      makeTask({
        taskId: 'task_failed',
        fileName: 'failed.pdf',
        status: 'failed',
        visibleStatus: 'Conversion failed',
        createdAt: '2026-04-25T00:00:00.000Z',
        updatedAt: '2026-04-25T00:03:00.000Z',
        error: {
          code: 'CONVERSION_FAILED',
          message: 'Conversion worker crashed.',
        },
      }),
      makeTask({
        taskId: 'task_expired',
        fileName: 'expired.pdf',
        status: 'expired',
        visibleStatus: 'Expired',
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
        expiredAt: '2026-04-26T00:00:00.000Z',
        error: {
          code: 'TASK_EXPIRED',
          message: 'Expired',
        },
      }),
    ]
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify(
        tasks.map((task) => ({
          taskId: task.taskId,
          fileName: task.file.name,
          createdAt: task.createdAt,
          expiresAt: task.expiresAt,
          fileSizeBytes: task.file.sizeBytes,
        }))
      )
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const task = tasks.find((item) => String(input).endsWith(`/api/tasks/${item.taskId}`))
        if (!task) {
          throw new Error(`Unexpected fetch: ${String(input)}`)
        }

        return successJson(task)
      })
    )

    render(<App />)

    const failedGroup = await screen.findByRole('group', { name: 'Failed tasks' })
    expect(within(failedGroup).getByText('failed.pdf')).toBeInTheDocument()
    expect(within(failedGroup).getByText('Conversion worker crashed.')).toBeInTheDocument()
    expect(within(failedGroup).queryByText(/Result unavailable/)).not.toBeInTheDocument()

    const expiredGroup = screen.getByRole('group', { name: 'Expired tasks' })
    expect(within(expiredGroup).getByText('expired.pdf')).toBeInTheDocument()
    expect(within(expiredGroup).getByText('Task has expired.')).toBeInTheDocument()
    expect(within(expiredGroup).queryByText(/Result expired/)).not.toBeInTheDocument()
  })

  it('paginates recent tasks after the first 20 entries', async () => {
    const tasks = Array.from({ length: 21 }, (_, index) => {
      const taskNumber = index + 1
      const hour = String(index).padStart(2, '0')

      return makeTask({
        taskId: `task_page_${taskNumber}`,
        fileName: `page-${taskNumber}.pdf`,
        status: 'succeeded',
        visibleStatus: 'Conversion complete',
        createdAt: `2026-04-25T${hour}:00:00.000Z`,
        updatedAt: `2026-04-25T${hour}:05:00.000Z`,
        outputSizeBytes: 1024 + taskNumber,
        dispatchStartedAt: `2026-04-25T${hour}:03:00.000Z`,
        dispatchCompletedAt: `2026-04-25T${hour}:05:00.000Z`,
      })
    })

    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify(
        tasks.map((task) => ({
          taskId: task.taskId,
          fileName: task.file.name,
          createdAt: task.createdAt,
          expiresAt: task.expiresAt,
          fileSizeBytes: task.file.sizeBytes,
        }))
      )
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const task = tasks.find((item) => String(input).endsWith(`/api/tasks/${item.taskId}`))
        if (!task) {
          throw new Error(`Unexpected fetch: ${String(input)}`)
        }

        return successJson(task)
      })
    )

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('page-21.pdf')).toBeInTheDocument()
    })

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    expect(screen.getByText('Showing 1-20 of 21')).toBeInTheDocument()
    expect(screen.queryByText('page-1.pdf')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next page' }))

    await waitFor(() => {
      expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    })

    expect(screen.getByText('Showing 21-21 of 21')).toBeInTheDocument()
    expect(screen.getByText('page-1.pdf')).toBeInTheDocument()
    expect(screen.queryByText('page-21.pdf')).not.toBeInTheDocument()
  })

  it('does not start a duplicate non-expired file upload from recent tasks', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    const fetchSpy = vi.fn(async () =>
      successJson({
        ...createdTask,
        status: 'processing',
        visibleStatus: 'Converting',
      })
    )
    vi.stubGlobal('fetch', fetchSpy)

    const user = userEvent.setup()
    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    const selectedFiles = await screen.findByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('sample.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('Already processing')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalledWith('http://localhost:8787/api/tasks', expect.anything())
  })

  it('allows re-upload of a file whose previous task failed with PROCESSING_TIMEOUT', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    const fetchSpy = vi.fn(async () =>
      successJson({
        ...createdTask,
        status: 'failed',
        visibleStatus: 'Conversion failed',
        error: {
          code: 'PROCESSING_TIMEOUT',
          message: 'Task exceeded the processing timeout window',
        },
      })
    )
    vi.stubGlobal('fetch', fetchSpy)

    const user = userEvent.setup()
    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    const selectedFiles = await screen.findByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('sample.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).queryByText('Already processing')).not.toBeInTheDocument()
    expect(within(selectedFiles).getByText('Ready')).toBeInTheDocument()
  })

  it('blocks duplicate files that match active or waiting uploads', async () => {
    const user = userEvent.setup()
    const { calls } = installQueuedUploadFetchMock()

    render(<App />)

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['two'], 'second.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(getTaskCreateFileNames(calls)).toEqual(['first.pdf', 'second.pdf'])
    })

    await user.upload(getFileInput(), [
      new File(['one'], 'first.pdf', { type: 'application/pdf' }),
      new File(['three'], 'third.pdf', { type: 'application/pdf' }),
    ])

    const selectedFiles = await screen.findByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('first.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getByText('third.pdf')).toBeInTheDocument()
    expect(within(selectedFiles).getAllByText('Already uploading')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Start processing' })).toBeDisabled()
  })

  it('prompts before a manual refresh while a file upload is still running', async () => {
    const user = userEvent.setup()
    let resolveR2Upload: (response: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/tasks')) {
          return successJson(createdTask, { status: 201 })
        }

        if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads`)) {
          return successJson(
            {
              taskId: createdTask.taskId,
              uploadId: 'upload_app_123',
              status: 'pending',
              partSizeBytes: 5 * 1024 * 1024,
              partCount: 1,
              presignedUrlTtlSeconds: 900,
            },
            { status: 201 }
          )
        }

        if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads/upload_app_123/parts/sign`)) {
          return successJson({
            taskId: createdTask.taskId,
            uploadId: 'upload_app_123',
            parts: [
              {
                partNumber: 1,
                url: 'https://r2.test/slow-part',
              },
            ],
          })
        }

        if (url === 'https://r2.test/slow-part') {
          return new Promise<Response>((resolve) => {
            resolveR2Upload = resolve
          })
        }

        if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads/upload_app_123/complete`)) {
          return successJson({
            ...createdTask,
            status: 'processing',
            visibleStatus: 'Converting',
          })
        }

        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await screen.findAllByText('Uploading 0%')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    resolveR2Upload(new Response(null, { headers: { ETag: '"etag-app-1"' } }))
  })

  it('keeps the upload zone in entry state after conversion succeeds', async () => {
    const user = userEvent.setup()
    installUploadFetchMock({
      completedTask: {
        status: 'succeeded',
        visibleStatus: 'Conversion complete',
        output: {
          sizeBytes: 2048,
        },
      },
    })

    render(<App />)

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    await user.click(screen.getByRole('button', { name: 'Start processing' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Results' })).toBeInTheDocument()
    })
    expect(within(getUploadZone()).getByText('Drag and drop files here')).toBeInTheDocument()
    expect(getUploadZone().querySelector('.upload-complete-badge')).not.toBeInTheDocument()
  })

  it('marks restored tasks as expired when the backend rejects them with TASK_EXPIRED', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        errorJson(
          {
            code: 'TASK_EXPIRED',
            message: 'Expired',
          },
          { status: 410 }
        )
      )
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('sample.pdf')).toBeInTheDocument()
    })
    expect(await screen.findByText('Task has expired.')).toBeInTheDocument()
  })

  it('removes restored tasks when the backend reports TASK_NOT_FOUND without showing conversion failure', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        errorJson(
          {
            code: 'TASK_NOT_FOUND',
            message: 'Task was not found',
          },
          { status: 404 }
        )
      )
    )

    const user = userEvent.setup()
    render(<App />)

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(PARSEOTTER_TASKS_STORAGE_KEY) ?? '[]')).toEqual([])
    })
    expect(screen.queryByRole('group', { name: 'Failed tasks' })).not.toBeInTheDocument()
    expect(screen.queryByText('Conversion failed')).not.toBeInTheDocument()

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    const selectedFiles = await screen.findByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).queryByText('Already processing')).not.toBeInTheDocument()
    expect(within(selectedFiles).getByText('Ready')).toBeInTheDocument()
  })

  it('shows a zip download action for successful tasks and opens the backend download URL', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith(`/api/tasks/${createdTask.taskId}/download`)) {
          return successJson({
            taskId: createdTask.taskId,
            url: 'https://r2.test/result.zip',
            expiresInSeconds: 600,
          })
        }

        return successJson({
          ...createdTask,
          status: 'succeeded',
          visibleStatus: 'Conversion complete',
        })
      })
    )

    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Download converted Markdown for sample.pdf' }))

    expect(open).toHaveBeenCalledWith('https://r2.test/result.zip', '_blank', 'noopener,noreferrer')
  })

  it('opens result downloads outside the current tab while another file is uploading', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const completedTask = makeTask({
      taskId: 'task_completed_download_existing',
      status: 'succeeded',
      visibleStatus: 'Conversion complete',
      version: 4,
      fileName: 'finished.pdf',
      fileSizeBytes: 21,
      outputSizeBytes: 2048,
      output: {
        objectKey: 'parseotter/task_completed_download_existing/output/result.zip',
        contentType: 'application/zip',
        sizeBytes: 2048,
      },
    })
    let resolveR2Upload: (response: Response) => void = () => {}

    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: completedTask.taskId,
          fileName: 'finished.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 21,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith(`/api/tasks/${completedTask.taskId}`)) {
          return successJson(completedTask)
        }

        if (url.endsWith(`/api/tasks/${completedTask.taskId}/download`)) {
          return successJson({
            taskId: completedTask.taskId,
            url: 'https://r2.test/finished.zip',
            expiresInSeconds: 600,
          })
        }

        if (url.endsWith('/api/tasks')) {
          return successJson(createdTask, { status: 201 })
        }

        if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads`)) {
          return successJson(
            {
              taskId: createdTask.taskId,
              uploadId: 'upload_app_123',
              status: 'pending',
              partSizeBytes: 5 * 1024 * 1024,
              partCount: 1,
              presignedUrlTtlSeconds: 900,
            },
            { status: 201 }
          )
        }

        if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads/upload_app_123/parts/sign`)) {
          return successJson({
            taskId: createdTask.taskId,
            uploadId: 'upload_app_123',
            parts: [
              {
                partNumber: 1,
                url: 'https://r2.test/slow-part',
              },
            ],
          })
        }

        if (url === 'https://r2.test/slow-part') {
          return new Promise<Response>((resolve) => {
            resolveR2Upload = resolve
          })
        }

        if (url.endsWith(`/api/tasks/${createdTask.taskId}/uploads/upload_app_123/complete`)) {
          return successJson({
            ...createdTask,
            status: 'processing',
            visibleStatus: 'Converting',
          })
        }

        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    render(<App />)

    await screen.findByRole('button', { name: 'Download converted Markdown for finished.pdf' })
    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'uploading.pdf', { type: 'application/pdf' }))
    await user.click(screen.getByRole('button', { name: 'Start processing' }))
    await screen.findAllByText('Uploading 0%')

    await user.click(screen.getByRole('button', { name: 'Download converted Markdown for finished.pdf' }))

    expect(open).toHaveBeenCalledWith('https://r2.test/finished.zip', '_blank', 'noopener,noreferrer')

    resolveR2Upload(new Response(null, { headers: { ETag: '"etag-app-1"' } }))
  })

  it('offers Download existing for duplicate converted files in Selected files', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith(`/api/tasks/${createdTask.taskId}/download`)) {
          return successJson({
            taskId: createdTask.taskId,
            url: 'https://r2.test/result.zip',
            expiresInSeconds: 600,
          })
        }

        return successJson({
          ...createdTask,
          status: 'succeeded',
          visibleStatus: 'Conversion complete',
        })
      })
    )

    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('button', { name: 'Download converted Markdown for sample.pdf' })

    await user.upload(getFileInput(), new File(['%PDF-1.7 body'], 'sample.pdf', { type: 'application/pdf' }))

    const selectedFiles = await screen.findByRole('region', { name: 'Selected files' })
    expect(within(selectedFiles).getByText('Converted result already exists.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start processing' })).toBeDisabled()

    await user.click(within(selectedFiles).getByRole('button', { name: 'Download existing converted Markdown for sample.pdf' }))

    expect(open).toHaveBeenCalledWith('https://r2.test/result.zip', '_blank', 'noopener,noreferrer')
  })

  it('keeps the zip download action available after a transient download failure', async () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: createdTask.taskId,
          fileName: 'sample.pdf',
          createdAt: '2026-04-25T00:00:00.000Z',
          expiresAt: '2099-05-27T00:00:00.000Z',
          fileSizeBytes: 13,
        },
      ])
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith(`/api/tasks/${createdTask.taskId}/download`)) {
          return errorJson(
            {
              code: 'REQUEST_FAILED',
              message: 'Temporary download failure',
            },
            { status: 503 }
          )
        }

        return successJson({
          ...createdTask,
          status: 'succeeded',
          visibleStatus: 'Conversion complete',
        })
      })
    )

    const user = userEvent.setup()
    render(<App />)

    const downloadButton = await screen.findByRole('button', { name: 'Download converted Markdown for sample.pdf' })
    await user.click(downloadButton)

    await waitFor(() => {
      expect(downloadButton).toBeEnabled()
    })
    expect(screen.getByRole('button', { name: 'Download converted Markdown for sample.pdf' })).toBeInTheDocument()
  })
})
