import { bytesToHex, hmacSha256, sha256Hex } from '../../lib/crypto'
import { AppHttpError } from '../http/errors'
import { readDownloadUrlTtlSeconds, readR2PresignedUrlTtlSeconds } from '../runtime-config'
import { createDownloadArchiveFilename, createDownloadContentDisposition } from './download-filename'
import {
  calculateMultipartPartCount,
  validateSignedPartNumbers,
  type SignedUploadPartsResponse,
} from './multipart-plan'

function requireEnvString(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppHttpError({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An internal server error occurred',
    })
  }

  return value.trim()
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function createObjectPath(bucket: string, key: string): string {
  return `/${encodePathSegment(bucket)}/${key.split('/').map(encodePathSegment).join('/')}`
}

function createCanonicalQueryString(params: URLSearchParams): string {
  const pairs = Array.from(params.entries()).map(([key, value]) => [encodePathSegment(key), encodePathSegment(value)])

  pairs.sort((left, right) => {
    if (left[0] === right[0]) {
      return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0
    }

    return left[0] < right[0] ? -1 : 1
  })

  return pairs.map(([key, value]) => `${key}=${value}`).join('&')
}

async function createSigningKey(secretAccessKey: string, dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = await hmacSha256(kDate, 'auto')
  const kService = await hmacSha256(kRegion, 's3')
  return hmacSha256(kService, 'aws4_request')
}

export async function presignUploadPartUrl(input: {
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  bucket: string
  key: string
  uploadId: string
  partNumber: number
  expiresInSeconds: number
  now?: Date
}): Promise<string> {
  const now = input.now ?? new Date()
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const endpoint = new URL(input.endpoint)
  const path = createObjectPath(input.bucket, input.key)
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const query = new URLSearchParams([
    ['partNumber', String(input.partNumber)],
    ['uploadId', input.uploadId],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
  ])
  const canonicalRequest = [
    'PUT',
    path,
    createCanonicalQueryString(query),
    `host:${endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n')
  const signature = bytesToHex(new Uint8Array(await hmacSha256(await createSigningKey(input.secretAccessKey, dateStamp), stringToSign)))

  query.set('X-Amz-Signature', signature)

  const url = new URL(`${endpoint.origin}${path}`)
  url.search = createCanonicalQueryString(query)

  return url.toString()
}

export async function presignGetObjectUrl(input: {
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  bucket: string
  key: string
  expiresInSeconds: number
  responseContentDisposition?: string
  now?: Date
}): Promise<string> {
  const now = input.now ?? new Date()
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const endpoint = new URL(input.endpoint)
  const path = createObjectPath(input.bucket, input.key)
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const query = new URLSearchParams([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
  ])

  if (input.responseContentDisposition) {
    query.set('response-content-disposition', input.responseContentDisposition)
  }

  const canonicalRequest = [
    'GET',
    path,
    createCanonicalQueryString(query),
    `host:${endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n')
  const signature = bytesToHex(new Uint8Array(await hmacSha256(await createSigningKey(input.secretAccessKey, dateStamp), stringToSign)))

  query.set('X-Amz-Signature', signature)

  const url = new URL(`${endpoint.origin}${path}`)
  url.search = createCanonicalQueryString(query)

  return url.toString()
}

export async function createSignedUploadPartsResponse(input: {
  taskId: string
  uploadId: string
  inputObjectKey: string
  fileSizeBytes: number
  partNumbers: number[]
  env: Partial<CloudflareBindings>
}): Promise<SignedUploadPartsResponse> {
  const partCount = calculateMultipartPartCount(input.fileSizeBytes)
  validateSignedPartNumbers(input.partNumbers, partCount)

  const accessKeyId = requireEnvString(input.env.R2_ACCESS_KEY_ID)
  const secretAccessKey = requireEnvString(input.env.R2_SECRET_ACCESS_KEY)
  const endpoint = requireEnvString(input.env.R2_S3_ENDPOINT)
  const bucket = requireEnvString(input.env.R2_BUCKET_NAME)
  const expiresInSeconds = readR2PresignedUrlTtlSeconds(input.env)
  const parts = await Promise.all(
    input.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await presignUploadPartUrl({
        accessKeyId,
        secretAccessKey,
        endpoint,
        bucket,
        key: input.inputObjectKey,
        uploadId: input.uploadId,
        partNumber,
        expiresInSeconds,
      }),
    }))
  )

  return {
    taskId: input.taskId,
    uploadId: input.uploadId,
    parts,
  }
}

export async function createPresignedDownloadUrl(input: {
  key: string
  fileName: string
  env: Partial<CloudflareBindings>
}): Promise<{ url: string; expiresInSeconds: number }> {
  const accessKeyId = requireEnvString(input.env.R2_ACCESS_KEY_ID)
  const secretAccessKey = requireEnvString(input.env.R2_SECRET_ACCESS_KEY)
  const endpoint = requireEnvString(input.env.R2_S3_ENDPOINT)
  const bucket = requireEnvString(input.env.R2_BUCKET_NAME)
  const expiresInSeconds = readDownloadUrlTtlSeconds(input.env)
  const archiveFileName = createDownloadArchiveFilename(input.fileName)

  return {
    url: await presignGetObjectUrl({
      accessKeyId,
      secretAccessKey,
      endpoint,
      bucket,
      key: input.key,
      expiresInSeconds,
      responseContentDisposition: createDownloadContentDisposition(archiveFileName),
    }),
    expiresInSeconds,
  }
}
