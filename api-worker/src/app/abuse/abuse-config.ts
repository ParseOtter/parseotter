import { readBooleanEnv, readNonNegativeIntegerEnv, readStringEnv } from '../../lib/env'

const DEFAULT_ABUSE_LIMITING_ENABLED = false
const DEFAULT_MAX_UPLOAD_FILE_SIZE_MB = 500
const DEFAULT_CLIENT_DAILY_DISPATCH_LIMIT = 3
const DEFAULT_CLIENT_DAILY_UPLOAD_BYTES_LIMIT = 300 * 1024 * 1024
const DEFAULT_CLIENT_ACTIVE_TASK_LIMIT = 2
const DEFAULT_CLIENT_CREATE_TASKS_PER_HOUR = 10
const DEFAULT_CLIENT_UPLOAD_SESSIONS_PER_HOUR = 10
const DEFAULT_CLIENT_COMPLETE_UPLOADS_PER_HOUR = 3
const DEFAULT_CLIENT_DOWNLOAD_URLS_PER_HOUR = 30
const DEFAULT_GLOBAL_ACTIVE_DISPATCH_LIMIT = 5
const DEFAULT_GLOBAL_PENDING_DISPATCH_LIMIT = 20
const DEFAULT_GLOBAL_DAILY_DISPATCH_LIMIT = 100
const DEFAULT_MAX_ESTIMATED_WAIT_SECONDS = 900
const DEFAULT_ESTIMATED_CONVERSION_SECONDS = 180

export type AbuseLimitConfig = {
  abuseLimitingEnabled: boolean
  convertPublicEnabled: boolean
  dispatchEnabled: boolean
  turnstileEnabled: boolean
  maxUploadFileSizeBytes: number
  clientDailyDispatchLimit: number
  clientDailyUploadBytesLimit: number
  clientActiveTaskLimit: number
  clientCreateTasksPerHour: number
  clientUploadSessionsPerHour: number
  clientCompleteUploadsPerHour: number
  clientDownloadUrlsPerHour: number
  globalActiveDispatchLimit: number
  globalPendingDispatchLimit: number
  globalDailyDispatchLimit: number
  maxEstimatedWaitSeconds: number
  estimatedConversionSeconds: number
}

export function readTurnstileEnabled(env?: Partial<CloudflareBindings>): boolean {
  if (!readAbuseLimitingEnabled(env)) {
    return false
  }

  const secretIsConfigured = readStringEnv(env, 'TURNSTILE_SECRET_KEY') !== null
  return readBooleanEnv(env, 'TURNSTILE_ENABLED', secretIsConfigured)
}

export function readAbuseLimitingEnabled(env?: Partial<CloudflareBindings>): boolean {
  return readBooleanEnv(env, 'ABUSE_LIMITING_ENABLED', DEFAULT_ABUSE_LIMITING_ENABLED)
}

export function readMaxUploadFileSizeBytes(env?: Partial<CloudflareBindings>): number {
  return readNonNegativeIntegerEnv(env, 'MAX_UPLOAD_FILE_SIZE_MB', DEFAULT_MAX_UPLOAD_FILE_SIZE_MB) * 1024 * 1024
}

export function readAbuseLimitConfig(env?: Partial<CloudflareBindings>): AbuseLimitConfig {
  const abuseLimitingEnabled = readAbuseLimitingEnabled(env)

  return {
    abuseLimitingEnabled,
    convertPublicEnabled: readBooleanEnv(env, 'CONVERT_PUBLIC_ENABLED', true),
    dispatchEnabled: readBooleanEnv(env, 'DISPATCH_ENABLED', true),
    turnstileEnabled: readTurnstileEnabled(env),
    maxUploadFileSizeBytes: readMaxUploadFileSizeBytes(env),
    clientDailyDispatchLimit: readNonNegativeIntegerEnv(
      env,
      'CLIENT_DAILY_DISPATCH_LIMIT',
      DEFAULT_CLIENT_DAILY_DISPATCH_LIMIT
    ),
    clientDailyUploadBytesLimit: readNonNegativeIntegerEnv(
      env,
      'CLIENT_DAILY_UPLOAD_BYTES_LIMIT',
      DEFAULT_CLIENT_DAILY_UPLOAD_BYTES_LIMIT
    ),
    clientActiveTaskLimit: readNonNegativeIntegerEnv(env, 'CLIENT_ACTIVE_TASK_LIMIT', DEFAULT_CLIENT_ACTIVE_TASK_LIMIT),
    clientCreateTasksPerHour: readNonNegativeIntegerEnv(
      env,
      'CLIENT_CREATE_TASKS_PER_HOUR',
      DEFAULT_CLIENT_CREATE_TASKS_PER_HOUR
    ),
    clientUploadSessionsPerHour: readNonNegativeIntegerEnv(
      env,
      'CLIENT_UPLOAD_SESSIONS_PER_HOUR',
      DEFAULT_CLIENT_UPLOAD_SESSIONS_PER_HOUR
    ),
    clientCompleteUploadsPerHour: readNonNegativeIntegerEnv(
      env,
      'CLIENT_COMPLETE_UPLOADS_PER_HOUR',
      DEFAULT_CLIENT_COMPLETE_UPLOADS_PER_HOUR
    ),
    clientDownloadUrlsPerHour: readNonNegativeIntegerEnv(
      env,
      'CLIENT_DOWNLOAD_URLS_PER_HOUR',
      DEFAULT_CLIENT_DOWNLOAD_URLS_PER_HOUR
    ),
    globalActiveDispatchLimit: readNonNegativeIntegerEnv(
      env,
      'GLOBAL_ACTIVE_DISPATCH_LIMIT',
      DEFAULT_GLOBAL_ACTIVE_DISPATCH_LIMIT
    ),
    globalPendingDispatchLimit: readNonNegativeIntegerEnv(
      env,
      'GLOBAL_PENDING_DISPATCH_LIMIT',
      DEFAULT_GLOBAL_PENDING_DISPATCH_LIMIT
    ),
    globalDailyDispatchLimit: readNonNegativeIntegerEnv(
      env,
      'GLOBAL_DAILY_DISPATCH_LIMIT',
      DEFAULT_GLOBAL_DAILY_DISPATCH_LIMIT
    ),
    maxEstimatedWaitSeconds: readNonNegativeIntegerEnv(
      env,
      'MAX_ESTIMATED_WAIT_SECONDS',
      DEFAULT_MAX_ESTIMATED_WAIT_SECONDS
    ),
    estimatedConversionSeconds: readNonNegativeIntegerEnv(
      env,
      'ESTIMATED_CONVERSION_SECONDS',
      DEFAULT_ESTIMATED_CONVERSION_SECONDS
    ),
  }
}
