import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewDialog } from '../../src/components/PreviewDialog'
import { previewCache } from '../../src/preview-cache'
import type { ParseOtterApiClient } from '../../src/parseotter-api'
import type { RestoredTaskView } from '../../src/task-view-mapping'

const mockGetDownload = vi.fn()
const mockFetch = vi.fn()
const mockRevokeObjectURL = vi.fn()

const api: ParseOtterApiClient = {
  getDownload: mockGetDownload,
  createTask: vi.fn(),
  createUploadSession: vi.fn(),
  signUploadParts: vi.fn(),
  completeUpload: vi.fn(),
  abortUpload: vi.fn(),
  getTask: vi.fn(),
  submitFeedback: vi.fn(),
}

const task: RestoredTaskView = {
  taskId: 'task_preview_test_12345678901234567890',
  fileName: 'test-report.pdf',
  fileType: 'application/pdf',
  fileSizeBytes: 1024,
  outputSizeBytes: 2048,
  status: 'succeeded',
  visibleStatus: 'Complete',
  errorCode: null,
  errorMessage: null,
  refreshErrorMessage: null,
  canDownload: true,
  isDownloading: false,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:01:00.000Z',
  expiresAt: '2099-05-27T00:00:00.000Z',
  dispatchStartedAt: null,
  dispatchCompletedAt: null,
}

async function makeZipBuffer(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    if (typeof content === 'string') {
      zip.file(name, content)
    } else {
      zip.file(name, content)
    }
  }
  return zip.generateAsync({ type: 'arraybuffer' })
}

async function makeZipResponse(files: Record<string, string | Uint8Array>): Promise<Response> {
  const buffer = await makeZipBuffer(files)
  const uint8 = new Uint8Array(buffer)

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(uint8)
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Length': String(uint8.length) },
  })
}

function setupFetchMock() {
  globalThis.fetch = mockFetch
}

describe('PreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    URL.revokeObjectURL = mockRevokeObjectURL
    previewCache.clear()
    mockRevokeObjectURL.mockClear()
    URL.createObjectURL = vi.fn((_blob: Blob) => `blob:mocked-${Math.random().toString(36).slice(2)}`)
    mockGetDownload.mockResolvedValue({
      taskId: task.taskId,
      url: 'https://example.com/result.zip',
      expiresInSeconds: 3600,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows loading state on open', () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(new Response(new Blob(), { status: 200 }))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    expect(screen.getByText('Preparing preview...')).toBeInTheDocument()
  })

  it('renders markdown content after successful load', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(await makeZipResponse({ 'output/report.md': '# Hello World' }))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
    })
  })

  it('serves cached preview on re-open without refetching', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(await makeZipResponse({ 'output/report.md': '# Cached Preview' }))

    const { unmount } = render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cached Preview')
    })

    unmount()
    mockGetDownload.mockClear()
    mockFetch.mockClear()

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cached Preview')
    expect(mockGetDownload).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('shows tabs when multiple .md files exist', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(
      await makeZipResponse({
        'output/main.md': '# Main',
        'output/appendix.md': '# Appendix',
      }),
    )

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('main.md')).toBeInTheDocument()
      expect(screen.getByText('appendix.md')).toBeInTheDocument()
    })
  })

  it('switches content when tab is clicked', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(
      await makeZipResponse({
        'output/main.md': '# Main',
        'output/appendix.md': '# Appendix',
      }),
    )

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('appendix.md')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('appendix.md'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Appendix')
    })
  })

  it('shows zip_too_large error when Content-Length exceeds 50MB', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(
      new Response(new Blob(), {
        status: 200,
        headers: { 'Content-Length': String(51 * 1024 * 1024) },
      }),
    )

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('File is too large to preview. Please download instead.')).toBeInTheDocument()
    })
  })

  it('shows a download fallback when decompressed markdown exceeds the preview limit', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(await makeZipResponse({ 'output/report.md': 'a'.repeat(5 * 1024 * 1024 + 1) }))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('File is too large to preview. Please download instead.')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })

  it('revokes created image URLs when image extraction exceeds the preview limits', async () => {
    setupFetchMock()
    const files: Record<string, string | Uint8Array> = {
      'output/report.md': '# Image heavy result',
    }
    for (let index = 0; index <= 100; index += 1) {
      files[`output/images/${index}.png`] = new Uint8Array([index])
    }
    mockFetch.mockResolvedValue(await makeZipResponse(files))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('File is too large to preview. Please download instead.')).toBeInTheDocument()
    })
    expect(mockRevokeObjectURL).toHaveBeenCalled()
  })

  it('shows no_md_files error when ZIP has no markdown files', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(await makeZipResponse({ 'image.png': new Uint8Array([1, 2, 3]) }))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('No Markdown content found in this result.')).toBeInTheDocument()
    })
  })

  it('shows fetch_error when network request fails', async () => {
    setupFetchMock()
    mockFetch.mockRejectedValue(new Error('Network error'))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load preview.')).toBeInTheDocument()
    })
  })

  it('shows retry and download buttons on fetch_error', async () => {
    setupFetchMock()
    mockFetch.mockRejectedValue(new Error('Network error'))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument()
      expect(screen.getByText('Download')).toBeInTheDocument()
    })
  })

  it('calls onDownload when download button is clicked in error state', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(await makeZipResponse({ 'image.png': new Uint8Array([1, 2, 3]) }))

    const onDownload = vi.fn()
    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={onDownload} />)

    await waitFor(() => {
      expect(screen.getByText('No Markdown content found in this result.')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('Download'))
    expect(onDownload).toHaveBeenCalledWith(task)
  })

  it('calls onClose when backdrop is clicked', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(new Response(new Blob(), { status: 200 }))

    const onClose = vi.fn()
    render(<PreviewDialog task={task} api={api} onClose={onClose} onDownload={vi.fn()} />)

    await userEvent.click(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', async () => {
    setupFetchMock()
    mockFetch.mockResolvedValue(new Response(new Blob(), { status: 200 }))

    const onClose = vi.fn()
    render(<PreviewDialog task={task} api={api} onClose={onClose} onDownload={vi.fn()} />)

    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('does not revoke blob URLs on unmount (they persist in cache)', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    setupFetchMock()
    mockFetch.mockResolvedValue(
      await makeZipResponse({
        'output/report.md': '# Test',
        'output/photo.png': imageBytes,
      }),
    )

    const { unmount } = render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByRole('heading')).toBeInTheDocument()
    })

    mockRevokeObjectURL.mockClear()
    unmount()
    expect(mockRevokeObjectURL).not.toHaveBeenCalled()
  })

  it('renders images with resolved blob URLs', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    setupFetchMock()
    mockFetch.mockResolvedValue(
      await makeZipResponse({
        'output/report.md': '![photo](images/photo.png)',
        'output/images/photo.png': imageBytes,
      }),
    )

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute('src', expect.stringContaining('blob:'))
    })
  })

  it('shows error when api.getDownload fails', async () => {
    setupFetchMock()
    mockGetDownload.mockRejectedValue(new Error('API error'))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load preview.')).toBeInTheDocument()
    })
  })

  it('retries loading when retry button is clicked', async () => {
    setupFetchMock()
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument()
    })

    const successResponse = await makeZipResponse({ 'report.md': '# Retry success' })
    mockFetch.mockResolvedValue(successResponse)

    await userEvent.click(screen.getByText('Retry'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Retry success')
    })
  })

  it('retry from error state still fetches and then caches the successful preview', async () => {
    setupFetchMock()
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const { unmount } = render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument()
    })

    mockGetDownload.mockClear()
    mockFetch.mockClear()
    mockFetch.mockResolvedValue(await makeZipResponse({ 'report.md': '# Retry cached success' }))

    await userEvent.click(screen.getByText('Retry'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Retry cached success')
    })

    expect(mockGetDownload).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    unmount()
    mockGetDownload.mockClear()
    mockFetch.mockClear()

    render(<PreviewDialog task={task} api={api} onClose={vi.fn()} onDownload={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Retry cached success')
    expect(mockGetDownload).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
