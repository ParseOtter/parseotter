import { AppHttpError } from '../app/http/errors'
import { isValidTaskId } from '../app/tasks/task-id'

export function createTaskNotFoundError(): AppHttpError {
  return new AppHttpError({
    status: 404,
    code: 'TASK_NOT_FOUND',
    message: 'Task was not found',
  })
}

export type TaskCoordinatorAction =
  | 'status'
  | 'download'
  | 'modal-callback'
  | 'upload-session'
  | 'sign-upload-parts'
  | 'complete-upload'
  | 'abort-upload'

export type TaskCoordinatorRoute = {
  taskId: string
  action: TaskCoordinatorAction
  uploadId?: string
}

const UPLOAD_ACTION_ROUTES: Array<{
  pattern: RegExp
  action: Extract<TaskCoordinatorAction, 'sign-upload-parts' | 'complete-upload' | 'abort-upload'>
}> = [
  {
    pattern: /^\/tasks\/([^/]+)\/uploads\/([^/]+)\/parts\/sign$/,
    action: 'sign-upload-parts',
  },
  {
    pattern: /^\/tasks\/([^/]+)\/uploads\/([^/]+)\/complete$/,
    action: 'complete-upload',
  },
  {
    pattern: /^\/tasks\/([^/]+)\/uploads\/([^/]+)\/abort$/,
    action: 'abort-upload',
  },
]

function createTaskCoordinatorRoute(
  taskId: string,
  action: TaskCoordinatorAction,
  uploadId?: string
): TaskCoordinatorRoute {
  if (!isValidTaskId(taskId)) {
    throw createTaskNotFoundError()
  }

  if (uploadId !== undefined) {
    return {
      taskId,
      action,
      uploadId: decodeURIComponent(uploadId),
    }
  }

  return {
    taskId,
    action,
  }
}

export function parseTaskCoordinatorPath(request: Request): TaskCoordinatorRoute {
  const url = new URL(request.url)

  for (const route of UPLOAD_ACTION_ROUTES) {
    const match = route.pattern.exec(url.pathname)
    if (match) {
      return createTaskCoordinatorRoute(match[1], route.action, match[2])
    }
  }

  const uploadMatch = /^\/tasks\/([^/]+)\/uploads$/.exec(url.pathname)
  if (uploadMatch) {
    return createTaskCoordinatorRoute(uploadMatch[1], 'upload-session')
  }

  const downloadMatch = /^\/tasks\/([^/]+)\/download$/.exec(url.pathname)
  if (downloadMatch) {
    return createTaskCoordinatorRoute(downloadMatch[1], 'download')
  }

  const modalCallbackMatch = /^\/tasks\/([^/]+)\/modal-callback$/.exec(url.pathname)
  if (modalCallbackMatch) {
    return createTaskCoordinatorRoute(modalCallbackMatch[1], 'modal-callback')
  }

  const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname)
  if (!taskMatch) {
    throw createTaskNotFoundError()
  }

  return createTaskCoordinatorRoute(taskMatch[1], 'status')
}
