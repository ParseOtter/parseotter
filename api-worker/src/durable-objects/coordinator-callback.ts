import { sendGa4TaskEvent } from '../app/analytics/ga4'
import { applyModalCallback, parseModalCallbackRequest } from '../app/tasks/modal-callback'
import { getAccessibleTaskSnapshot } from '../app/tasks/task-record'
import { isTerminalTaskStatus } from '../app/tasks/task-status'
import { createTaskSnapshotResponse } from './coordinator-task-lifecycle'
import { createTaskNotFoundError } from './coordinator-routing'

export async function handleModalCallback(
  env: CloudflareBindings,
  request: Request,
  taskId: string,
  requestId: string
): Promise<Response> {
  const callback = parseModalCallbackRequest(await request.text())

  if (callback.taskId !== taskId) {
    throw createTaskNotFoundError()
  }

  const previousSnapshot = await getAccessibleTaskSnapshot(env.DB, taskId)
  const snapshot = await applyModalCallback({
    db: env.DB,
    bucket: env.R2_BUCKET,
    callback,
  })
  if (!isTerminalTaskStatus(previousSnapshot.status) && snapshot.status === 'succeeded') {
    await sendGa4TaskEvent({
      env,
      snapshot,
      name: 'parseotter_conversion_completed',
    })
  }
  if (!isTerminalTaskStatus(previousSnapshot.status) && snapshot.status === 'failed') {
    await sendGa4TaskEvent({
      env,
      snapshot,
      name: 'parseotter_conversion_failed',
    })
  }

  return createTaskSnapshotResponse(snapshot, requestId)
}
