import { AlertCircle, Download, Eye, FileText, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import JSZip from 'jszip'

import type { ParseOtterApiClient } from '../parseotter-api'
import type { RestoredTaskView } from '../task-view-mapping'
import { formatBytes } from '../format'
import { previewCache } from '../preview-cache'
import { DialogShell } from './DialogShell'
import { MarkdownRenderer, type MdFile } from './MarkdownRenderer'
import './PreviewDialog.css'

const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_FILE_COUNT = 200
const MAX_MARKDOWN_PREVIEW_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024
const MAX_PREVIEW_IMAGE_COUNT = 100
const MAX_TOTAL_EXTRACTED_BYTES = 20 * 1024 * 1024

type PreviewErrorReason = 'zip_too_large' | 'preview_too_large' | 'no_md_files' | 'fetch_error' | 'parse_error'

type PreviewState =
  | { phase: 'loading_url' }
  | { phase: 'downloading'; percent?: number; downloadedBytes?: number }
  | { phase: 'extracting' }
  | { phase: 'ready'; mdFiles: MdFile[]; imageMap: Map<string, string>; selectedMdIndex: number }
  | { phase: 'error'; reason: PreviewErrorReason }

class PreviewResourceLimitError extends Error {
  constructor() {
    super('Preview is too large.')
    this.name = 'PreviewResourceLimitError'
  }
}

type ZipEntryWithMetadata = JSZip.JSZipObject & {
  _data?: {
    uncompressedSize?: unknown
  }
}

function getUtf8ByteLength(value: string): number {
  return new Blob([value]).size
}

function getEntryUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as ZipEntryWithMetadata)._data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null
}

function assertCanAddBytes(currentBytes: number, addedBytes: number, limitBytes: number): void {
  if (addedBytes > limitBytes || currentBytes + addedBytes > limitBytes) {
    throw new PreviewResourceLimitError()
  }
}

function revokeImageUrls(imageMap: Map<string, string>): void {
  for (const url of imageMap.values()) {
    URL.revokeObjectURL(url)
  }
}

function getImageMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

function isMarkdownFile(name: string): boolean {
  return /\.md$/i.test(name)
}

function isImageFile(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)
}

async function extractPreviewFiles(zip: JSZip): Promise<{ mdFiles: MdFile[]; imageMap: Map<string, string> }> {
  const fileEntries = Object.entries(zip.files).filter(([, entry]) => !entry.dir)
  if (fileEntries.length > MAX_PREVIEW_FILE_COUNT) {
    throw new PreviewResourceLimitError()
  }

  const mdFiles: MdFile[] = []
  const imageMap = new Map<string, string>()
  let markdownBytes = 0
  let imageBytes = 0
  let totalExtractedBytes = 0
  let imageCount = 0

  try {
    for (const [name, entry] of fileEntries) {
      if (isMarkdownFile(name)) {
        const declaredSize = getEntryUncompressedSize(entry)
        if (declaredSize !== null) {
          assertCanAddBytes(markdownBytes, declaredSize, MAX_MARKDOWN_PREVIEW_BYTES)
          assertCanAddBytes(totalExtractedBytes, declaredSize, MAX_TOTAL_EXTRACTED_BYTES)
        }

        let content: string
        try {
          content = await entry.async('string')
        } catch {
          continue
        }

        const contentBytes = getUtf8ByteLength(content)
        assertCanAddBytes(markdownBytes, contentBytes, MAX_MARKDOWN_PREVIEW_BYTES)
        assertCanAddBytes(totalExtractedBytes, contentBytes, MAX_TOTAL_EXTRACTED_BYTES)
        markdownBytes += contentBytes
        totalExtractedBytes += contentBytes
        mdFiles.push({ name, content })
      } else if (isImageFile(name)) {
        if (imageCount >= MAX_PREVIEW_IMAGE_COUNT) {
          throw new PreviewResourceLimitError()
        }

        const declaredSize = getEntryUncompressedSize(entry)
        if (declaredSize !== null) {
          assertCanAddBytes(0, declaredSize, MAX_IMAGE_PREVIEW_BYTES)
          assertCanAddBytes(imageBytes, declaredSize, MAX_TOTAL_EXTRACTED_BYTES)
          assertCanAddBytes(totalExtractedBytes, declaredSize, MAX_TOTAL_EXTRACTED_BYTES)
        }

        let data: Uint8Array
        try {
          data = await entry.async('uint8array')
        } catch {
          continue
        }

        const dataBytes = data.byteLength
        assertCanAddBytes(0, dataBytes, MAX_IMAGE_PREVIEW_BYTES)
        assertCanAddBytes(imageBytes, dataBytes, MAX_TOTAL_EXTRACTED_BYTES)
        assertCanAddBytes(totalExtractedBytes, dataBytes, MAX_TOTAL_EXTRACTED_BYTES)
        imageBytes += dataBytes
        totalExtractedBytes += dataBytes
        imageCount += 1

        const blob = new Blob([data.buffer as ArrayBuffer], { type: getImageMimeType(name) })
        const blobUrl = URL.createObjectURL(blob)
        imageMap.set(name, blobUrl)
      }
    }
  } catch (error) {
    revokeImageUrls(imageMap)
    throw error
  }

  return { mdFiles, imageMap }
}

export function PreviewDialog({
  task,
  api,
  onClose,
  onDownload,
}: {
  task: RestoredTaskView
  api: ParseOtterApiClient
  onClose: () => void
  onDownload: (task: RestoredTaskView) => void
}) {
  const [state, setState] = useState<PreviewState>({ phase: 'loading_url' })

  const close = useCallback(() => {
    onClose()
  }, [onClose])

  const handleDownload = useCallback(() => {
    onDownload(task)
  }, [onDownload, task])

  const loadPreview = useCallback(async () => {
    const cached = previewCache.get(task.taskId)
    if (cached) {
      setState({ phase: 'ready', mdFiles: cached.mdFiles, imageMap: cached.imageMap, selectedMdIndex: 0 })
      return
    }

    setState({ phase: 'loading_url' })

    let downloadUrl: string
    try {
      const response = await api.getDownload(task.taskId)
      downloadUrl = response.url
    } catch {
      setState({ phase: 'error', reason: 'fetch_error' })
      return
    }

    setState({ phase: 'downloading' })

    let response: Response
    try {
      response = await fetch(downloadUrl)
    } catch {
      setState({ phase: 'error', reason: 'fetch_error' })
      return
    }

    if (!response.ok) {
      setState({ phase: 'error', reason: 'fetch_error' })
      return
    }

    const contentLength = response.headers.get('Content-Length')
    const totalBytes = contentLength ? parseInt(contentLength, 10) : null

    if (totalBytes !== null && totalBytes > MAX_ZIP_SIZE_BYTES) {
      setState({ phase: 'error', reason: 'zip_too_large' })
      return
    }

    if (!response.body) {
      setState({ phase: 'error', reason: 'fetch_error' })
      return
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let downloadedBytes = 0

    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        setState({ phase: 'error', reason: 'fetch_error' })
        return
      }

      if (result.done) break

      chunks.push(result.value)
      downloadedBytes += result.value.length

      if (downloadedBytes > MAX_ZIP_SIZE_BYTES) {
        reader.cancel()
        setState({ phase: 'error', reason: 'zip_too_large' })
        return
      }

      if (totalBytes) {
        setState({ phase: 'downloading', percent: Math.round((downloadedBytes / totalBytes) * 100) })
      } else {
        setState({ phase: 'downloading', downloadedBytes })
      }
    }

    const buffer = new Uint8Array(downloadedBytes)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.length
    }

    setState({ phase: 'extracting' })

    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(buffer)
    } catch {
      setState({ phase: 'error', reason: 'parse_error' })
      return
    }

    let mdFiles: MdFile[]
    let imageMap: Map<string, string>
    try {
      const previewFiles = await extractPreviewFiles(zip)
      mdFiles = previewFiles.mdFiles
      imageMap = previewFiles.imageMap
    } catch (error) {
      setState({ phase: 'error', reason: error instanceof PreviewResourceLimitError ? 'preview_too_large' : 'parse_error' })
      return
    }

    if (mdFiles.length === 0) {
      revokeImageUrls(imageMap)
      setState({ phase: 'error', reason: 'no_md_files' })
      return
    }

    mdFiles.sort((a, b) => b.content.length - a.content.length)

    previewCache.set(task.taskId, { mdFiles, imageMap })
    setState({ phase: 'ready', mdFiles, imageMap, selectedMdIndex: 0 })
  }, [api, task.taskId])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const phase = state.phase

  return (
    <DialogShell
      open={true}
      onClose={close}
      ariaLabel={`Preview ${task.fileName}`}
      backdropClassName="preview-backdrop"
      dialogClassName="preview-dialog"
    >
      <div className="preview-header">
        <div className="preview-header-info">
          <Eye size={18} aria-hidden="true" />
          <span id="preview-title" className="preview-title-text">
            {task.fileName}
          </span>
          <span className="preview-format-badge">Markdown</span>
        </div>
        <button className="icon-button" type="button" data-close-button aria-label="Close preview" onClick={close}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="preview-body">
        {(phase === 'loading_url' || phase === 'downloading' || phase === 'extracting') && (
          <div className="preview-status">
            {phase === 'loading_url' && (
              <>
                <div className="preview-spinner" />
                <p>Preparing preview...</p>
              </>
            )}
            {phase === 'downloading' && (
              <>
                <div className="preview-spinner" />
                <p>
                  {state.percent !== undefined
                    ? `Downloading... ${state.percent}%`
                    : state.downloadedBytes !== undefined
                      ? `Downloading... ${formatBytes(state.downloadedBytes)}`
                      : 'Downloading result...'}
                </p>
              </>
            )}
            {phase === 'extracting' && (
              <>
                <div className="preview-spinner" />
                <p>Extracting files...</p>
              </>
            )}
          </div>
        )}

        {phase === 'ready' && (
          <>
            {state.mdFiles.length > 1 && (
              <div className="preview-tabs">
                {state.mdFiles.map((file, index) => (
                  <button
                    key={file.name}
                    className={`preview-tab ${index === state.selectedMdIndex ? 'preview-tab-active' : ''}`}
                    type="button"
                    onClick={() => setState({ ...state, selectedMdIndex: index })}
                  >
                    <FileText size={13} aria-hidden="true" />
                    {file.name.split('/').pop() ?? file.name}
                  </button>
                ))}
              </div>
            )}
            <MarkdownRenderer mdFile={state.mdFiles[state.selectedMdIndex]} imageMap={state.imageMap} />
          </>
        )}

        {phase === 'error' && (
          <div className="preview-error">
            <AlertCircle size={28} aria-hidden="true" />
            {(state.reason === 'zip_too_large' || state.reason === 'preview_too_large') && (
              <>
                <p>File is too large to preview. Please download instead.</p>
                <button className="download-button" type="button" onClick={handleDownload}>
                  <Download size={15} aria-hidden="true" />
                  Download
                </button>
              </>
            )}
            {state.reason === 'no_md_files' && (
              <>
                <p>No Markdown content found in this result.</p>
                <button className="download-button" type="button" onClick={handleDownload}>
                  <Download size={15} aria-hidden="true" />
                  Download
                </button>
              </>
            )}
            {(state.reason === 'fetch_error' || state.reason === 'parse_error') && (
              <>
                <p>Failed to load preview.</p>
                <div className="preview-error-actions">
                  <button className="secondary-button" type="button" onClick={() => void loadPreview()}>
                    <RotateCw size={15} aria-hidden="true" />
                    Retry
                  </button>
                  <button className="download-button" type="button" onClick={handleDownload}>
                    <Download size={15} aria-hidden="true" />
                    Download
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
