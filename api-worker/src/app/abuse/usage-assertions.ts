import { AppHttpError } from '../http/errors'
import { readAbuseLimitConfig } from './abuse-config'
import {
  countClientActionEventsSince,
  countClientActiveTasks,
  countClientCreatedTasksSince,
  countGlobalActiveDispatches,
  countGlobalPendingDispatches,
  oneHourBefore,
  readClientDailyUsage,
  readGlobalDailyUsage,
  type AbuseEventType,
  type AbuseRoute,
} from './usage-queries'
import { recordAbuseEvent } from './usage-tracking'

function createLimitError(input: { status?: number; code: string; message: string }): AppHttpError {
  return new AppHttpError({
    status: input.status ?? 429,
    code: input.code,
    message: input.message,
  })
}

async function rejectForAbuseLimit(input: {
  db: D1Database
  route: AbuseRoute
  eventType?: AbuseEventType
  clientHash?: string | null
  taskId?: string | null
  requestId?: string | null
  code: string
  message: string
  status?: number
  now: Date
}): Promise<never> {
  const error = createLimitError({
    status: input.status,
    code: input.code,
    message: input.message,
  })

  await recordAbuseEvent(input.db, {
    route: input.route,
    eventType: input.eventType ?? 'quota_rejected',
    reasonCode: input.code,
    status: error.status,
    clientHash: input.clientHash,
    taskId: input.taskId,
    requestId: input.requestId,
    now: input.now,
  })

  throw error
}

async function assertGlobalDailyDispatchAllowed(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  route: AbuseRoute
  clientHash?: string | null
  taskId?: string | null
  requestId?: string | null
  now: Date
}): Promise<void> {
  const config = readAbuseLimitConfig(input.env)
  const globalUsage = await readGlobalDailyUsage(input.db, input.now)

  if (globalUsage.dispatchCount >= config.globalDailyDispatchLimit) {
    await rejectForAbuseLimit({
      ...input,
      code: 'GLOBAL_DAILY_DISPATCH_LIMIT_EXCEEDED',
      message: "Today's free conversion capacity is currently full. Please try again later.",
    })
  }
}

async function assertGlobalQueueAllowed(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  route: AbuseRoute
  clientHash?: string | null
  taskId?: string | null
  requestId?: string | null
  now: Date
}): Promise<void> {
  const config = readAbuseLimitConfig(input.env)
  const pendingCount = await countGlobalPendingDispatches(input.db, input.now)

  if (pendingCount >= config.globalPendingDispatchLimit) {
    await rejectForAbuseLimit({
      ...input,
      code: 'GLOBAL_QUEUE_FULL',
      message: 'The service is busy. Please try again later.',
    })
  }

  if (config.maxEstimatedWaitSeconds <= 0 || config.globalActiveDispatchLimit <= 0) {
    return
  }

  const estimatedWaitSeconds =
    Math.ceil((pendingCount + 1) / config.globalActiveDispatchLimit) * config.estimatedConversionSeconds
  if (estimatedWaitSeconds > config.maxEstimatedWaitSeconds) {
    await rejectForAbuseLimit({
      ...input,
      code: 'GLOBAL_ESTIMATED_WAIT_TOO_LONG',
      message: 'The service is busy. Please try again later.',
    })
  }
}

export async function assertCreateTaskAllowed(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  clientHash: string
  fileSizeBytes: number
  requestId?: string | null
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  const config = readAbuseLimitConfig(input.env)

  if (!config.abuseLimitingEnabled) {
    return
  }

  if (!config.convertPublicEnabled) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'create_task',
      eventType: 'disabled',
      clientHash: input.clientHash,
      requestId: input.requestId,
      code: 'CONVERSION_DISABLED',
      message: 'Free conversion is temporarily unavailable. Please try again later.',
      status: 503,
      now,
    })
  }

  await assertGlobalDailyDispatchAllowed({
    db: input.db,
    env: input.env,
    route: 'create_task',
    clientHash: input.clientHash,
    requestId: input.requestId,
    now,
  })
  await assertGlobalQueueAllowed({
    db: input.db,
    env: input.env,
    route: 'create_task',
    clientHash: input.clientHash,
    requestId: input.requestId,
    now,
  })

  const hourlyCreates = await countClientCreatedTasksSince(input.db, {
    clientHash: input.clientHash,
    since: oneHourBefore(now),
  })
  if (hourlyCreates >= config.clientCreateTasksPerHour) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'create_task',
      clientHash: input.clientHash,
      requestId: input.requestId,
      code: 'CLIENT_CREATE_RATE_LIMITED',
      message: 'Too many conversion requests. Please try again later.',
      now,
    })
  }

  const activeTasks = await countClientActiveTasks(input.db, {
    clientHash: input.clientHash,
    now,
  })
  if (activeTasks >= config.clientActiveTaskLimit) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'create_task',
      clientHash: input.clientHash,
      requestId: input.requestId,
      code: 'CLIENT_ACTIVE_TASK_LIMIT_EXCEEDED',
      message: 'You already have a conversion in progress.',
      now,
    })
  }

  const clientUsage = await readClientDailyUsage(input.db, {
    clientHash: input.clientHash,
    now,
  })
  if (clientUsage.dispatchCount >= config.clientDailyDispatchLimit) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'create_task',
      clientHash: input.clientHash,
      requestId: input.requestId,
      code: 'CLIENT_DAILY_DISPATCH_LIMIT_EXCEEDED',
      message: "Today's free conversion limit has been used.",
      now,
    })
  }

  if (clientUsage.uploadCompletedBytes + input.fileSizeBytes > config.clientDailyUploadBytesLimit) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'create_task',
      clientHash: input.clientHash,
      requestId: input.requestId,
      code: 'CLIENT_DAILY_UPLOAD_BYTES_LIMIT_EXCEEDED',
      message: "Today's free upload limit has been used.",
      now,
    })
  }
}

export async function assertUploadSessionAllowed(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  clientHash: string
  taskId: string
  requestId?: string | null
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  const config = readAbuseLimitConfig(input.env)

  if (!config.abuseLimitingEnabled) {
    return
  }

  const recentSessions = await countClientActionEventsSince(input.db, {
    clientHash: input.clientHash,
    route: 'upload_session',
    since: oneHourBefore(now),
  })

  if (recentSessions >= config.clientUploadSessionsPerHour) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'upload_session',
      clientHash: input.clientHash,
      taskId: input.taskId,
      requestId: input.requestId,
      code: 'CLIENT_UPLOAD_SESSION_RATE_LIMITED',
      message: 'Too many upload sessions. Please try again later.',
      now,
    })
  }
}

export async function assertCompleteUploadAllowed(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  clientHash: string
  taskId: string
  fileSizeBytes: number
  requestId?: string | null
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  const config = readAbuseLimitConfig(input.env)

  if (!config.abuseLimitingEnabled) {
    return
  }

  const recentCompletions = await countClientActionEventsSince(input.db, {
    clientHash: input.clientHash,
    route: 'complete_upload',
    since: oneHourBefore(now),
  })

  if (recentCompletions >= config.clientCompleteUploadsPerHour) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'complete_upload',
      clientHash: input.clientHash,
      taskId: input.taskId,
      requestId: input.requestId,
      code: 'CLIENT_COMPLETE_UPLOAD_RATE_LIMITED',
      message: 'Too many completed uploads. Please try again later.',
      now,
    })
  }

  const usage = await readClientDailyUsage(input.db, {
    clientHash: input.clientHash,
    now,
  })
  if (usage.dispatchCount >= config.clientDailyDispatchLimit) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'complete_upload',
      clientHash: input.clientHash,
      taskId: input.taskId,
      requestId: input.requestId,
      code: 'CLIENT_DAILY_DISPATCH_LIMIT_EXCEEDED',
      message: "Today's free conversion limit has been used.",
      now,
    })
  }

  if (usage.uploadCompletedBytes + input.fileSizeBytes > config.clientDailyUploadBytesLimit) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'complete_upload',
      clientHash: input.clientHash,
      taskId: input.taskId,
      requestId: input.requestId,
      code: 'CLIENT_DAILY_UPLOAD_BYTES_LIMIT_EXCEEDED',
      message: "Today's free upload limit has been used.",
      now,
    })
  }

  await assertGlobalDailyDispatchAllowed({
    db: input.db,
    env: input.env,
    route: 'complete_upload',
    clientHash: input.clientHash,
    taskId: input.taskId,
    requestId: input.requestId,
    now,
  })
  await assertGlobalQueueAllowed({
    db: input.db,
    env: input.env,
    route: 'complete_upload',
    clientHash: input.clientHash,
    taskId: input.taskId,
    requestId: input.requestId,
    now,
  })
}

export async function assertDownloadAllowed(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  clientHash: string
  taskId: string
  requestId?: string | null
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  const config = readAbuseLimitConfig(input.env)

  if (!config.abuseLimitingEnabled) {
    return
  }

  const recentDownloads = await countClientActionEventsSince(input.db, {
    clientHash: input.clientHash,
    route: 'download',
    since: oneHourBefore(now),
  })

  if (recentDownloads >= config.clientDownloadUrlsPerHour) {
    await rejectForAbuseLimit({
      db: input.db,
      route: 'download',
      clientHash: input.clientHash,
      taskId: input.taskId,
      requestId: input.requestId,
      code: 'CLIENT_DOWNLOAD_RATE_LIMITED',
      message: 'Too many download requests. Please try again later.',
      now,
    })
  }
}

export async function assertDispatchMayStart(input: {
  db: D1Database
  env: Partial<CloudflareBindings>
  now?: Date
}): Promise<boolean> {
  const now = input.now ?? new Date()
  const config = readAbuseLimitConfig(input.env)

  if (!config.abuseLimitingEnabled) {
    return true
  }

  if (!config.dispatchEnabled) {
    return false
  }

  const [activeDispatches, globalUsage] = await Promise.all([
    countGlobalActiveDispatches(input.db, now),
    readGlobalDailyUsage(input.db, now),
  ])

  return activeDispatches < config.globalActiveDispatchLimit && globalUsage.dispatchCount < config.globalDailyDispatchLimit
}
