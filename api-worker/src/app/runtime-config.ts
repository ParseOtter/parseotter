import { readPositiveIntegerEnv, splitCsv } from '../lib/env'

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
]
const DEFAULT_TASK_RETENTION_HOURS = 48
const DEFAULT_R2_PRESIGNED_URL_TTL_SECONDS = 900
const DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 600
const DEFAULT_MODAL_CALLBACK_TOLERANCE_SECONDS = 300
const DEFAULT_PROCESSING_TIMEOUT_SECONDS = 1800

export function readCorsOrigins(env?: Partial<CloudflareBindings>): string[] {
  const configured = env?.CORS_ORIGINS

  if (typeof configured !== 'string' || configured.trim().length === 0) {
    return DEFAULT_CORS_ORIGINS
  }

  const origins = splitCsv(configured)
  return origins.length > 0 ? origins : DEFAULT_CORS_ORIGINS
}

export function readTaskRetentionHours(env?: Partial<CloudflareBindings>): number {
  return readPositiveIntegerEnv(env, 'TASK_RETENTION_HOURS', DEFAULT_TASK_RETENTION_HOURS)
}

export function readR2PresignedUrlTtlSeconds(env?: Partial<CloudflareBindings>): number {
  return readPositiveIntegerEnv(env, 'R2_PRESIGNED_URL_TTL_SECONDS', DEFAULT_R2_PRESIGNED_URL_TTL_SECONDS)
}

export function readDownloadUrlTtlSeconds(env?: Partial<CloudflareBindings>): number {
  return readPositiveIntegerEnv(env, 'DOWNLOAD_URL_TTL_SECONDS', DEFAULT_DOWNLOAD_URL_TTL_SECONDS)
}

export function readModalCallbackToleranceSeconds(env?: Partial<CloudflareBindings>): number {
  return readPositiveIntegerEnv(env, 'MODAL_CALLBACK_TOLERANCE_SECONDS', DEFAULT_MODAL_CALLBACK_TOLERANCE_SECONDS)
}

export function readProcessingTimeoutSeconds(env?: Partial<CloudflareBindings>): number {
  return readPositiveIntegerEnv(env, 'PROCESSING_TIMEOUT_SECONDS', DEFAULT_PROCESSING_TIMEOUT_SECONDS)
}
