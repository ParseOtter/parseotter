import { AppHttpError } from '../http/errors'
import { createSingleValidationIssueError } from '../http/validation'
import { readR2PresignedUrlTtlSeconds } from '../runtime-config'

export const R2_MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024
export const R2_MAX_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024
export const R2_MAX_MULTIPART_PARTS = 10_000
export const MULTIPART_UPLOAD_PART_SIZE_BYTES = R2_MIN_MULTIPART_PART_SIZE_BYTES

export type UploadSessionResponse = {
  taskId: string
  uploadId: string
  status: string
  partSizeBytes: number
  partCount: number
  presignedUrlTtlSeconds: number
}

export type SignedUploadPartsRequest = {
  partNumbers: number[]
}

export type SignedUploadPartsResponse = {
  taskId: string
  uploadId: string
  parts: Array<{
    partNumber: number
    url: string
  }>
}

export type CompletedUploadPart = {
  partNumber: number
  etag: string
}

export type CompleteUploadRequest = {
  parts: CompletedUploadPart[]
}

export type MultipartUploadPlan = {
  partSizeBytes: number
  partCount: number
  lastPartSizeBytes: number
}

function createMultipartConstraintError(): AppHttpError {
  return new AppHttpError({
    status: 400,
    code: 'UPLOAD_PART_INVALID',
    message: 'Multipart upload violates R2 multipart constraints',
  })
}

export function createMultipartUploadPlan(
  fileSizeBytes: number,
  partSizeBytes = MULTIPART_UPLOAD_PART_SIZE_BYTES
): MultipartUploadPlan {
  if (
    !Number.isSafeInteger(partSizeBytes) ||
    partSizeBytes < R2_MIN_MULTIPART_PART_SIZE_BYTES ||
    partSizeBytes > R2_MAX_MULTIPART_PART_SIZE_BYTES
  ) {
    throw createMultipartConstraintError()
  }

  const partCount = Math.ceil(fileSizeBytes / partSizeBytes)

  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > R2_MAX_MULTIPART_PARTS) {
    throw createMultipartConstraintError()
  }

  return {
    partSizeBytes,
    partCount,
    lastPartSizeBytes: fileSizeBytes - partSizeBytes * (partCount - 1),
  }
}

export function calculateMultipartPartCount(
  fileSizeBytes: number,
  partSizeBytes = MULTIPART_UPLOAD_PART_SIZE_BYTES
): number {
  return createMultipartUploadPlan(fileSizeBytes, partSizeBytes).partCount
}

export function createUploadSessionResponse(input: {
  taskId: string
  uploadId: string
  status: string
  fileSizeBytes: number
  env?: Partial<CloudflareBindings>
}): UploadSessionResponse {
  const plan = createMultipartUploadPlan(input.fileSizeBytes)

  return {
    taskId: input.taskId,
    uploadId: input.uploadId,
    status: input.status,
    partSizeBytes: plan.partSizeBytes,
    partCount: plan.partCount,
    presignedUrlTtlSeconds: readR2PresignedUrlTtlSeconds(input.env),
  }
}

function readPartNumbers(payload: Record<string, unknown>): number[] {
  const value = payload.partNumbers

  if (!Array.isArray(value) || value.length === 0) {
    throw createSingleValidationIssueError({
      field: 'partNumbers',
      code: 'invalid_type',
      message: 'partNumbers must be a non-empty array',
    })
  }

  return value.map((partNumber, index) => {
    if (typeof partNumber !== 'number' || !Number.isSafeInteger(partNumber) || partNumber <= 0) {
      throw createSingleValidationIssueError({
        field: `partNumbers[${index}]`,
        code: 'invalid_integer',
        message: 'partNumbers must contain positive integers',
      })
    }

    return partNumber
  })
}

export function parseSignedUploadPartsRequest(payload: Record<string, unknown>): SignedUploadPartsRequest {
  return {
    partNumbers: readPartNumbers(payload),
  }
}

function normalizeCompletedUploadPartEtag(etag: string): string {
  const trimmed = etag.trim()

  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function readCompletedUploadParts(payload: Record<string, unknown>): CompletedUploadPart[] {
  const value = payload.parts

  if (!Array.isArray(value) || value.length === 0) {
    throw createSingleValidationIssueError({
      field: 'parts',
      code: 'invalid_type',
      message: 'parts must be a non-empty array',
    })
  }

  return value.map((part, index) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      throw createSingleValidationIssueError({
        field: `parts[${index}]`,
        code: 'invalid_type',
        message: 'parts must contain objects',
      })
    }

    const record = part as Record<string, unknown>
    const partNumber = record.partNumber
    const etag = record.etag

    if (typeof partNumber !== 'number' || !Number.isSafeInteger(partNumber) || partNumber <= 0) {
      throw createSingleValidationIssueError({
        field: `parts[${index}].partNumber`,
        code: 'invalid_integer',
        message: 'partNumber must be a positive integer',
      })
    }

    if (typeof etag !== 'string') {
      throw createSingleValidationIssueError({
        field: `parts[${index}].etag`,
        code: 'invalid_type',
        message: 'etag must be a string',
      })
    }

    return {
      partNumber,
      etag: normalizeCompletedUploadPartEtag(etag),
    }
  })
}

export function parseCompleteUploadRequest(payload: Record<string, unknown>): CompleteUploadRequest {
  return {
    parts: readCompletedUploadParts(payload),
  }
}

export function validateSignedPartNumbers(partNumbers: readonly number[], partCount: number): void {
  const uniquePartNumbers = new Set<number>()

  for (const partNumber of partNumbers) {
    if (uniquePartNumbers.has(partNumber)) {
      throw new AppHttpError({
        status: 400,
        code: 'UPLOAD_PART_INVALID',
        message: 'Part numbers must be unique for this upload',
      })
    }

    uniquePartNumbers.add(partNumber)

    if (partNumber > partCount) {
      throw new AppHttpError({
        status: 400,
        code: 'UPLOAD_PART_INVALID',
        message: 'Part number is out of range for this upload',
      })
    }
  }
}

function createInvalidCompletedPartsError(): AppHttpError {
  return new AppHttpError({
    status: 400,
    code: 'UPLOAD_PART_INVALID',
    message: 'Completed parts manifest is invalid for this upload',
  })
}

export function validateCompletedUploadParts(parts: readonly CompletedUploadPart[], partCount: number): void {
  if (parts.length !== partCount) {
    throw createInvalidCompletedPartsError()
  }

  for (const [index, part] of parts.entries()) {
    const expectedPartNumber = index + 1

    if (part.partNumber !== expectedPartNumber || part.partNumber > partCount || part.etag.length === 0) {
      throw createInvalidCompletedPartsError()
    }
  }
}

export function createCompletedUploadParts(input: {
  parts: CompletedUploadPart[]
  fileSizeBytes: number
}): R2UploadedPart[] {
  const partCount = calculateMultipartPartCount(input.fileSizeBytes)
  const normalizedParts = input.parts.map((part) => ({
    partNumber: part.partNumber,
    etag: normalizeCompletedUploadPartEtag(part.etag),
  }))

  validateCompletedUploadParts(normalizedParts, partCount)

  return normalizedParts.map((part) => ({
    partNumber: part.partNumber,
    etag: part.etag,
  }))
}
