import { ParseOtterApiError } from './parseotter-api'
import type { RestoredTaskView } from './task-view-mapping'

function getApiErrorDisplayMessage(error: unknown): string {
  if (error instanceof ParseOtterApiError && error.code === 'TASK_EXPIRED') {
    return 'Task has expired.'
  }

  return error instanceof Error ? error.message : 'Unable to refresh task status.'
}

export function mapRefreshErrorToTask(task: RestoredTaskView, error: unknown): RestoredTaskView {
  if (error instanceof ParseOtterApiError && error.code === 'TASK_EXPIRED') {
    return {
      ...task,
      status: 'expired',
      visibleStatus: 'Expired',
      errorCode: 'TASK_EXPIRED',
      errorMessage: getApiErrorDisplayMessage(error),
      refreshErrorMessage: null,
      canDownload: false,
      isDownloading: false,
    }
  }

  return {
    ...task,
    refreshErrorMessage: getApiErrorDisplayMessage(error),
    isDownloading: false,
  }
}

export function isTaskNotFoundRefreshError(error: unknown): boolean {
  return error instanceof ParseOtterApiError && error.code === 'TASK_NOT_FOUND'
}

export function mapDownloadErrorToTask(task: RestoredTaskView, error: unknown): RestoredTaskView {
  if (error instanceof ParseOtterApiError && error.code === 'TASK_EXPIRED') {
    return {
      ...task,
      status: 'expired',
      visibleStatus: 'Expired',
      errorCode: 'TASK_EXPIRED',
      errorMessage: 'Task has expired.',
      canDownload: false,
      isDownloading: false,
    }
  }

  if (error instanceof ParseOtterApiError && (error.code === 'TASK_NOT_FOUND' || error.code === 'RESULT_NOT_FOUND')) {
    return {
      ...task,
      errorCode: error.code,
      errorMessage: error.message,
      canDownload: false,
      isDownloading: false,
    }
  }

  return {
    ...task,
    errorMessage: error instanceof Error ? error.message : 'Download failed.',
    canDownload: true,
    isDownloading: false,
  }
}
