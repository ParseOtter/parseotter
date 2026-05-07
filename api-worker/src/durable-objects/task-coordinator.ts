import { DurableObject } from 'cloudflare:workers'

import { AppHttpError, normalizeAppError } from '../app/http/errors'
import { resolveRequestId } from '../app/http/request-id'
import { jsonError } from '../app/http/responses'
import { handleModalCallback } from './coordinator-callback'
import { getDownload, getTask, createTask } from './coordinator-task-lifecycle'
import {
  abortUpload,
  completeUpload,
  createUploadSession,
  signUploadParts,
} from './coordinator-upload'
import { parseTaskCoordinatorPath } from './coordinator-routing'

function createMethodNotAllowedError(): AppHttpError {
  return new AppHttpError({
    status: 405,
    code: 'METHOD_NOT_ALLOWED',
    message: 'Method is not allowed for this task route',
  })
}

export class TaskCoordinator extends DurableObject<CloudflareBindings> {
  async fetch(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request)

    try {
      const route = parseTaskCoordinatorPath(request)

      switch (route.action) {
        case 'status':
          if (request.method === 'POST') {
            return createTask(this.env, request, route.taskId, requestId)
          }
          if (request.method === 'GET') {
            return getTask(this.env, route.taskId, requestId)
          }
          break
        case 'upload-session':
          if (request.method === 'POST') {
            return createUploadSession(this.env, route.taskId, requestId)
          }
          break
        case 'sign-upload-parts':
          if (request.method === 'POST' && route.uploadId) {
            return signUploadParts(this.env, request, route.taskId, route.uploadId, requestId)
          }
          break
        case 'complete-upload':
          if (request.method === 'POST' && route.uploadId) {
            return completeUpload(this.env, request, route.taskId, route.uploadId, requestId)
          }
          break
        case 'abort-upload':
          if (request.method === 'POST' && route.uploadId) {
            return abortUpload(this.env, request, route.taskId, route.uploadId, requestId)
          }
          break
        case 'download':
          if (request.method === 'GET') {
            return getDownload(this.env, request, route.taskId, requestId)
          }
          break
        case 'modal-callback':
          if (request.method === 'POST') {
            return handleModalCallback(this.env, request, route.taskId, requestId)
          }
          break
      }

      throw createMethodNotAllowedError()
    } catch (error) {
      return jsonError(normalizeAppError(error), requestId)
    }
  }
}
