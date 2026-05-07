import { clearTaskObjectKeyAfterCleanup, listExpiredTaskSnapshots, markTaskExpiredForCleanup } from './task-record'
import type { TaskSnapshot } from './task-status'

export type ExpiredTaskCleanupBucket = Pick<R2Bucket, 'delete'>

export type ExpiredTaskCleanupInput = {
  db: D1Database
  bucket: ExpiredTaskCleanupBucket
  now?: Date
  limit?: number
}

export type ExpiredTaskCleanupResult = {
  scanned: number
  markedExpired: number
  objectsDeleted: number
  objectDeleteFailures: number
}

type TaskObjectKey = {
  field: 'input' | 'output'
  objectKey: string
}

function createEmptyResult(): ExpiredTaskCleanupResult {
  return {
    scanned: 0,
    markedExpired: 0,
    objectsDeleted: 0,
    objectDeleteFailures: 0,
  }
}

function getTaskObjectKeys(snapshot: TaskSnapshot): TaskObjectKey[] {
  return [
    snapshot.inputObjectKey
      ? {
          field: 'input' as const,
          objectKey: snapshot.inputObjectKey,
        }
      : null,
    snapshot.outputObjectKey
      ? {
          field: 'output' as const,
          objectKey: snapshot.outputObjectKey,
        }
      : null,
  ].filter((key): key is TaskObjectKey => key !== null)
}

async function deleteTaskObjects(input: {
  db: D1Database
  bucket: ExpiredTaskCleanupBucket
  taskId: string
  objectKeys: TaskObjectKey[]
  now: Date
}): Promise<Pick<ExpiredTaskCleanupResult, 'objectsDeleted' | 'objectDeleteFailures'>> {
  let result = {
    objectsDeleted: 0,
    objectDeleteFailures: 0,
  }

  for (const objectKey of input.objectKeys) {
    try {
      await input.bucket.delete(objectKey.objectKey)
      await clearTaskObjectKeyAfterCleanup(input.db, {
        taskId: input.taskId,
        field: objectKey.field,
        objectKey: objectKey.objectKey,
        now: input.now,
      })
      result = {
        ...result,
        objectsDeleted: result.objectsDeleted + 1,
      }
    } catch {
      result = {
        ...result,
        objectDeleteFailures: result.objectDeleteFailures + 1,
      }
    }
  }

  return result
}

export async function cleanupExpiredTasks(input: ExpiredTaskCleanupInput): Promise<ExpiredTaskCleanupResult> {
  const now = input.now ?? new Date()
  const snapshots = await listExpiredTaskSnapshots(input.db, now, input.limit)
  let result = createEmptyResult()

  for (const snapshot of snapshots) {
    const marked = await markTaskExpiredForCleanup(input.db, snapshot, now)
    const deleted = await deleteTaskObjects({
      db: input.db,
      bucket: input.bucket,
      taskId: marked.snapshot.taskId,
      objectKeys: getTaskObjectKeys(marked.snapshot),
      now,
    })

    result = {
      scanned: result.scanned + 1,
      markedExpired: result.markedExpired + (marked.marked ? 1 : 0),
      objectsDeleted: result.objectsDeleted + deleted.objectsDeleted,
      objectDeleteFailures: result.objectDeleteFailures + deleted.objectDeleteFailures,
    }
  }

  return result
}
