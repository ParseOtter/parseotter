import { AppHttpError } from '../http/errors'
import { createOutputObjectKey } from './modal-dispatch'
import { createPresignedDownloadUrl } from './r2-presigner'
import type { TaskSnapshot } from './task-status'

export type DownloadResultResponse = {
  taskId: string
  url: string
  expiresInSeconds: number
}

export async function createDownloadResultResponse(input: {
  snapshot: TaskSnapshot
  bucket: R2Bucket
  env: Partial<CloudflareBindings>
}): Promise<DownloadResultResponse> {
  if (input.snapshot.status !== 'succeeded') {
    throw new AppHttpError({
      status: 409,
      code: 'RESULT_NOT_READY',
      message: 'Result is not ready',
    })
  }

  const expectedOutputObjectKey = createOutputObjectKey(input.snapshot.taskId)
  if (input.snapshot.outputObjectKey !== expectedOutputObjectKey) {
    throw new AppHttpError({
      status: 404,
      code: 'RESULT_NOT_FOUND',
      message: 'Result object is not available yet',
    })
  }

  const outputObject = await input.bucket.head(input.snapshot.outputObjectKey)
  if (!outputObject) {
    throw new AppHttpError({
      status: 404,
      code: 'RESULT_NOT_FOUND',
      message: 'Result object is not available yet',
    })
  }

  const presigned = await createPresignedDownloadUrl({
    key: input.snapshot.outputObjectKey,
    fileName: input.snapshot.fileName,
    env: input.env,
  })

  return {
    taskId: input.snapshot.taskId,
    url: presigned.url,
    expiresInSeconds: presigned.expiresInSeconds,
  }
}
