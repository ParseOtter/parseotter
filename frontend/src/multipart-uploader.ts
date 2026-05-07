import type { CompletedPart, ParseOtterApiClient, TaskResponse, UploadSessionResponse } from './parseotter-api'

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024

const SUPPORTED_FILE_TYPES = new Set(['application/pdf', 'application/epub+zip', 'application/x-epub+zip'])
const SUPPORTED_FILE_EXTENSIONS = new Map([
  ['.pdf', 'application/pdf'],
  ['.epub', 'application/epub+zip'],
])

type R2Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function createDefaultR2Fetch(): R2Fetch {
  return (input, init) => globalThis.fetch(input, init)
}

export type UploadProgress = {
  uploadedBytes: number
  totalBytes: number
  percent: number
  bytesPerSecond: number
}

type UploadDocumentResult = {
  task: TaskResponse
  upload: UploadSessionResponse
  completedTask: TaskResponse
}

type UploadDocumentInput = {
  api: ParseOtterApiClient
  file: File
  r2Fetch?: R2Fetch
  signal?: AbortSignal
  maxPartAttempts?: number
  partConcurrency?: number
  onTaskCreated?: (task: TaskResponse) => void
  onUploadSessionCreated?: (upload: UploadSessionResponse) => void
  onProgress?: (progress: UploadProgress) => void
  onVerificationStarted?: () => void
  getTurnstileToken?: () => Promise<string | null>
  gaClientId?: string | null
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadValidationError'
  }
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

export function resolveFileType(file: File): string | null {
  if (SUPPORTED_FILE_TYPES.has(file.type)) {
    return file.type === 'application/x-epub+zip' ? 'application/epub+zip' : file.type
  }

  return SUPPORTED_FILE_EXTENSIONS.get(getFileExtension(file.name)) ?? null
}

export function validateUploadFile(file: File): string {
  const fileType = resolveFileType(file)
  if (!fileType) {
    throw new UploadValidationError('Choose a PDF or EPUB file.')
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UploadValidationError('File must be 100 MB or smaller.')
  }

  return fileType
}

function getPartNumbers(partCount: number): number[] {
  return Array.from({ length: partCount }, (_value, index) => index + 1)
}

function getPartBlob(file: File, partNumber: number, partSizeBytes: number): Blob {
  const start = (partNumber - 1) * partSizeBytes
  return file.slice(start, Math.min(file.size, start + partSizeBytes))
}

function getPartSizeBytes(file: File, partNumber: number, partSizeBytes: number): number {
  const start = (partNumber - 1) * partSizeBytes
  return Math.max(0, Math.min(file.size, start + partSizeBytes) - start)
}

function calculateAverageBytesPerSecond(uploadedBytes: number, startedAtMs: number): number {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAtMs) / 1000)
  return Math.round(uploadedBytes / elapsedSeconds)
}

function isExpiredPresignedUrlResponse(response: Response): boolean {
  return response.status === 401 || response.status === 403
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Upload aborted', 'AbortError')
  }
}

async function signPart(input: {
  api: ParseOtterApiClient
  taskId: string
  uploadId: string
  partNumber: number
}): Promise<string> {
  const signed = await input.api.signUploadParts(input.taskId, input.uploadId, [input.partNumber])
  const signedPart = signed.parts.find((part) => part.partNumber === input.partNumber)
  if (!signedPart) {
    throw new Error(`Missing signed URL for part ${input.partNumber}.`)
  }

  return signedPart.url
}

async function uploadPart(input: {
  api: ParseOtterApiClient
  file: File
  taskId: string
  uploadId: string
  partNumber: number
  partSizeBytes: number
  r2Fetch: R2Fetch
  signal?: AbortSignal
  maxPartAttempts: number
}): Promise<CompletedPart> {
  let signedUrl = await signPart(input)
  let attempt = 0

  while (attempt < input.maxPartAttempts) {
    attempt += 1
    throwIfAborted(input.signal)

    let response: Response

    try {
      response = await input.r2Fetch(signedUrl, {
        method: 'PUT',
        body: getPartBlob(input.file, input.partNumber, input.partSizeBytes),
        signal: input.signal,
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      if (attempt >= input.maxPartAttempts) {
        throw new Error(`Upload failed for part ${input.partNumber}.`)
      }

      continue
    }

    if (response.ok) {
      const etag = response.headers.get('etag')
      if (!etag) {
        throw new Error(`R2 did not return an ETag for part ${input.partNumber}.`)
      }

      return {
        partNumber: input.partNumber,
        etag,
      }
    }

    if (isExpiredPresignedUrlResponse(response) && attempt < input.maxPartAttempts) {
      signedUrl = await signPart(input)
      continue
    }

    if (attempt >= input.maxPartAttempts) {
      throw new Error(`Upload failed for part ${input.partNumber}.`)
    }
  }

  throw new Error(`Upload failed for part ${input.partNumber}.`)
}

async function uploadParts(input: {
  api: ParseOtterApiClient
  file: File
  taskId: string
  upload: UploadSessionResponse
  r2Fetch: R2Fetch
  signal?: AbortSignal
  maxPartAttempts: number
  partConcurrency: number
  onProgress?: (progress: UploadProgress) => void
}): Promise<CompletedPart[]> {
  const partNumbers = getPartNumbers(input.upload.partCount)
  const completedParts: CompletedPart[] = []
  const uploadedPartBytes = new Map<number, number>()
  const startedAtMs = Date.now()
  let nextPartIndex = 0

  function reportProgress(partNumber: number): void {
    uploadedPartBytes.set(partNumber, getPartSizeBytes(input.file, partNumber, input.upload.partSizeBytes))
    const uploadedBytes = Math.min(
      input.file.size,
      Array.from(uploadedPartBytes.values()).reduce((total, sizeBytes) => total + sizeBytes, 0)
    )

    input.onProgress?.({
      uploadedBytes,
      totalBytes: input.file.size,
      percent: input.file.size === 0 ? 100 : Math.round((uploadedBytes / input.file.size) * 100),
      bytesPerSecond: calculateAverageBytesPerSecond(uploadedBytes, startedAtMs),
    })
  }

  async function runWorker(): Promise<void> {
    while (nextPartIndex < partNumbers.length) {
      const partNumber = partNumbers[nextPartIndex]
      nextPartIndex += 1

      const completedPart = await uploadPart({
        api: input.api,
        file: input.file,
        taskId: input.taskId,
        uploadId: input.upload.uploadId,
        partNumber,
        partSizeBytes: input.upload.partSizeBytes,
        r2Fetch: input.r2Fetch,
        signal: input.signal,
        maxPartAttempts: input.maxPartAttempts,
      })

      completedParts.push(completedPart)
      reportProgress(partNumber)
    }
  }

  const workerCount = Math.max(1, Math.min(input.partConcurrency, partNumbers.length))
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return completedParts.sort((left, right) => left.partNumber - right.partNumber)
}

export async function uploadDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  const fileType = validateUploadFile(input.file)
  const r2Fetch = input.r2Fetch ?? createDefaultR2Fetch()
  const maxPartAttempts = input.maxPartAttempts ?? 3
  const partConcurrency = input.partConcurrency ?? 3
  let task: TaskResponse | null = null
  let upload: UploadSessionResponse | null = null
  let uploadCompleted = false

  try {
    throwIfAborted(input.signal)
    input.onVerificationStarted?.()
    const turnstileToken = (await input.getTurnstileToken?.()) ?? null
    throwIfAborted(input.signal)
    task = await input.api.createTask({
      fileName: input.file.name,
      fileType,
      fileSizeBytes: input.file.size,
      turnstileToken,
      gaClientId: input.gaClientId ?? null,
    })
    input.onTaskCreated?.(task)

    throwIfAborted(input.signal)
    upload = await input.api.createUploadSession(task.taskId)
    input.onUploadSessionCreated?.(upload)

    const completedParts = await uploadParts({
      api: input.api,
      file: input.file,
      taskId: task.taskId,
      upload,
      r2Fetch,
      signal: input.signal,
      maxPartAttempts,
      partConcurrency,
      onProgress: input.onProgress,
    })

    throwIfAborted(input.signal)
    const completedTask = await input.api.completeUpload(task.taskId, upload.uploadId, completedParts)
    uploadCompleted = true

    return {
      task,
      upload,
      completedTask,
    }
  } catch (error) {
    if (task && upload && !uploadCompleted) {
      try {
        await input.api.abortUpload(task.taskId, upload.uploadId)
      } catch {
        // Best-effort cleanup; preserve the original upload error for the caller.
      }
    }

    if (input.signal?.aborted || isAbortError(error)) {
      throw new DOMException('Upload aborted', 'AbortError')
    }

    throw error
  }
}
