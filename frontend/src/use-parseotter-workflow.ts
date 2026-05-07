import { useEffect, useMemo } from 'react'

import { TURNSTILE_SITE_KEY } from './config'
import { createParseOtterApiClient } from './parseotter-api'
import { createTurnstileTokenProvider } from './turnstile'
import { useFileSelection } from './use-file-selection'
import { useTaskPersistence } from './use-task-persistence'
import { useUploadQueue } from './use-upload-queue'

export type { SelectedFileView } from './duplicate-detection'
export type { RestoredTaskView } from './task-view-mapping'
export type { ActiveUploadView, QueuedUploadView } from './upload-queue'

export function useParseOtterWorkflow() {
  const api = useMemo(() => createParseOtterApiClient(), [])
  const getTurnstileToken = useMemo(() => createTurnstileTokenProvider(TURNSTILE_SITE_KEY), [])

  const taskPersistence = useTaskPersistence({ api })
  const uploadQueue = useUploadQueue({
    api,
    getTurnstileToken,
    onTaskSettled: taskPersistence.upsertTask,
  })
  const fileSelection = useFileSelection({
    restoredTasks: taskPersistence.restoredTasks,
    queuedUploads: uploadQueue.queuedUploads,
    activeUploads: uploadQueue.activeUploads,
    onStartProcessing: uploadQueue.enqueueUploads,
  })

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      if (uploadQueue.queuedUploads.length === 0 && uploadQueue.activeUploads.length === 0) {
        return
      }

      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [uploadQueue.activeUploads.length, uploadQueue.queuedUploads.length])

  return {
    selectedFiles: fileSelection.selectedFiles,
    queuedUploads: uploadQueue.queuedUploads,
    activeUploads: uploadQueue.activeUploads,
    restoredTasks: taskPersistence.restoredTasks,
    api,
    handleFiles: fileSelection.handleFiles,
    removeSelectedFile: fileSelection.removeSelectedFile,
    clearSelectedFiles: fileSelection.clearSelectedFiles,
    handleStartProcessing: fileSelection.handleStartProcessing,
    handleCancelQueuedUpload: uploadQueue.handleCancelQueuedUpload,
    handleCancelActiveUpload: uploadQueue.handleCancelActiveUpload,
    handleDownloadTask: taskPersistence.handleDownloadTask,
  }
}
