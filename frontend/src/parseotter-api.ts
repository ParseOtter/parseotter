import { PARSEOTTER_API_BASE_URL } from './config'

type ApiErrorBody = {
  code: string
  message: string
  details?: unknown
}

type ApiEnvelope<T> =
  | {
      success: true
      data: T
      error: null
    }
  | {
      success: false
      data: null
      error: ApiErrorBody
    }

export type TaskResponse = {
  taskId: string
  status: string
  visibleStatus: string
  version: number
  attempt: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  expiredAt: string | null
  error: {
    code: string
    message: string | null
  } | null
  file: {
    name: string
    type: string
    sizeBytes: number
  }
  upload: {
    uploadId: string | null
    status: string | null
    inputObjectKey: string | null
    inputSizeBytes: number | null
    inputEtag: string | null
    inputContentType: string | null
    inputPartCount: number | null
    inputChecksumSha256: string | null
  }
  output: {
    objectKey: string | null
    contentType: string | null
    sizeBytes: number | null
  }
  dispatch: {
    status: string | null
    attempt: number
    idempotencyKey: string | null
    startedAt: string | null
    completedAt: string | null
    lastCallbackIdempotencyKey: string | null
  }
}

type CreateTaskRequest = {
  fileName: string
  fileType: string
  fileSizeBytes: number
  turnstileToken?: string | null
  gaClientId?: string | null
}

export type UploadSessionResponse = {
  taskId: string
  uploadId: string
  status: string
  partSizeBytes: number
  partCount: number
  presignedUrlTtlSeconds: number
}

type SignedPartsResponse = {
  taskId: string
  uploadId: string
  parts: Array<{
    partNumber: number
    url: string
  }>
}

export type CompletedPart = {
  partNumber: number
  etag: string
}

type DownloadResponse = {
  taskId: string
  url: string
  expiresInSeconds: number
}

export type FeedbackCategory = 'bug' | 'conversion_quality' | 'performance' | 'feature_request' | 'other'

type CreateFeedbackRequest = {
  category: FeedbackCategory
  rating: number | null
  message: string
  contact: string | null
  pageUrl: string | null
  companyName: string
}

type FeedbackResponse = {
  feedbackId: string
  receivedAt: string
}

export type ParseOtterApiClient = {
  createTask(input: CreateTaskRequest): Promise<TaskResponse>
  createUploadSession(taskId: string): Promise<UploadSessionResponse>
  signUploadParts(taskId: string, uploadId: string, partNumbers: number[]): Promise<SignedPartsResponse>
  completeUpload(taskId: string, uploadId: string, parts: CompletedPart[]): Promise<TaskResponse>
  abortUpload(taskId: string, uploadId: string): Promise<void>
  getTask(taskId: string): Promise<TaskResponse>
  getDownload(taskId: string): Promise<DownloadResponse>
  submitFeedback(input: CreateFeedbackRequest): Promise<FeedbackResponse>
}

export class ParseOtterApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(input: { message: string; code: string; status: number; details?: unknown }) {
    super(input.message)
    this.name = 'ParseOtterApiError'
    this.code = input.code
    this.status = input.status
    this.details = input.details
  }
}

type Fetcher = typeof fetch

function createDefaultFetcher(): Fetcher {
  return (input, init) => globalThis.fetch(input, init)
}

function createUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

async function readJsonEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new ParseOtterApiError({
      status: response.status,
      code: response.ok ? 'INVALID_RESPONSE' : 'REQUEST_FAILED',
      message: response.ok ? 'Unexpected response from conversion service.' : 'Conversion service request failed.',
    })
  }

  return (await response.json()) as ApiEnvelope<T>
}

async function requestJson<T>(
  input: {
    baseUrl: string
    fetcher: Fetcher
    path: string
    method: 'GET' | 'POST'
    body?: unknown
  }
): Promise<T> {
  const response = await input.fetcher(createUrl(input.baseUrl, input.path), {
    method: input.method,
    headers: input.body
      ? {
          'content-type': 'application/json',
        }
      : undefined,
    body: input.body ? JSON.stringify(input.body) : undefined,
  })
  const envelope = await readJsonEnvelope<T>(response)

  if (!response.ok || !envelope.success) {
    const error = envelope.success
      ? {
          code: 'REQUEST_FAILED',
          message: 'Conversion service request failed.',
        }
      : envelope.error

    throw new ParseOtterApiError({
      status: response.status,
      code: error.code,
      message: error.message,
      details: 'details' in error ? error.details : undefined,
    })
  }

  return envelope.data
}

export function createParseOtterApiClient(input?: { baseUrl?: string; fetcher?: Fetcher }): ParseOtterApiClient {
  const baseUrl = input?.baseUrl ?? PARSEOTTER_API_BASE_URL
  const fetcher = input?.fetcher ?? createDefaultFetcher()

  return {
    createTask: (body) =>
      requestJson<TaskResponse>({
        baseUrl,
        fetcher,
        path: '/api/tasks',
        method: 'POST',
        body,
      }),
    createUploadSession: (taskId) =>
      requestJson<UploadSessionResponse>({
        baseUrl,
        fetcher,
        path: `/api/tasks/${encodeURIComponent(taskId)}/uploads`,
        method: 'POST',
      }),
    signUploadParts: (taskId, uploadId, partNumbers) =>
      requestJson<SignedPartsResponse>({
        baseUrl,
        fetcher,
        path: `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(uploadId)}/parts/sign`,
        method: 'POST',
        body: {
          partNumbers,
        },
      }),
    completeUpload: (taskId, uploadId, parts) =>
      requestJson<TaskResponse>({
        baseUrl,
        fetcher,
        path: `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
        method: 'POST',
        body: {
          parts,
        },
      }),
    abortUpload: async (taskId, uploadId) => {
      await requestJson<TaskResponse>({
        baseUrl,
        fetcher,
        path: `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(uploadId)}/abort`,
        method: 'POST',
      })
    },
    getTask: (taskId) =>
      requestJson<TaskResponse>({
        baseUrl,
        fetcher,
        path: `/api/tasks/${encodeURIComponent(taskId)}`,
        method: 'GET',
      }),
    getDownload: (taskId) =>
      requestJson<DownloadResponse>({
        baseUrl,
        fetcher,
        path: `/api/tasks/${encodeURIComponent(taskId)}/download`,
        method: 'GET',
      }),
    submitFeedback: (body) =>
      requestJson<FeedbackResponse>({
        baseUrl,
        fetcher,
        path: '/api/feedback',
        method: 'POST',
        body,
      }),
  }
}
