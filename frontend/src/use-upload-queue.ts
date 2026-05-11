import { useCallback, useEffect, useRef, useState } from 'react'

import { getGaClientId } from './analytics'
import { uploadDocument, UploadValidationError } from './multipart-uploader'
import { ParseOtterApiError, type ParseOtterApiClient } from './parseotter-api'
import { createFailedUploadTaskView, createQueuedUploadView, createActiveUploadView, FILE_UPLOAD_CONCURRENCY_LIMIT, isUploadAbortError, uploadStatusFromProgress, type ActiveUploadView, type QueuedUploadView } from './upload-queue'
import type { RestoredTaskView } from './task-view-mapping'
import { mapTaskResponseToView } from './task-view-mapping'

type QueuableSelectedFile = {
  localId: string
  file: File
  fileName: string
  fileSizeBytes: number
}

type UseUploadQueueInput = {
  api: ParseOtterApiClient
  getTurnstileToken: () => Promise<string | null>
  onTaskSettled: (task: RestoredTaskView) => void
}

export function useUploadQueue(input: UseUploadQueueInput) {
  const { api, getTurnstileToken, onTaskSettled } = input
  const abortControllersByLocalIdRef = useRef<Map<string, AbortController>>(new Map())
  const activeUploadsRef = useRef<ActiveUploadView[]>([])
  const [queuedUploads, setQueuedUploads] = useState<QueuedUploadView[]>([])
  const [activeUploads, setActiveUploads] = useState<ActiveUploadView[]>([])

  useEffect(() => {
    activeUploadsRef.current = activeUploads
  }, [activeUploads])

  const updateActiveUpload = useCallback((localId: string, updater: (upload: ActiveUploadView) => ActiveUploadView): void => {
    setActiveUploads((currentUploads) => currentUploads.map((upload) => (upload.localId === localId ? updater(upload) : upload)))
  }, [])

  const runQueuedUpload = useCallback(
    async (queuedUpload: QueuedUploadView, abortController: AbortController): Promise<void> => {
      const isCurrentUpload = () => abortControllersByLocalIdRef.current.get(queuedUpload.localId) === abortController

      try {
        const gaClientId = await getGaClientId()
        const result = await uploadDocument({
          api,
          file: queuedUpload.file,
          signal: abortController.signal,
          getTurnstileToken,
          gaClientId,
          onVerificationStarted: () => {
            if (!isCurrentUpload()) {
              return
            }

            updateActiveUpload(queuedUpload.localId, (upload) => ({
              ...upload,
              status: 'Verifying browser',
            }))
          },
          onTaskCreated: (task) => {
            if (!isCurrentUpload()) {
              return
            }

            updateActiveUpload(queuedUpload.localId, (upload) => ({
              ...upload,
              taskId: task.taskId,
              phase: 'preparing',
              status: 'Preparing upload',
              totalBytes: queuedUpload.fileSizeBytes,
              canCancel: true,
            }))
          },
          onUploadSessionCreated: () => {
            if (!isCurrentUpload()) {
              return
            }

            updateActiveUpload(queuedUpload.localId, (upload) => ({
              ...upload,
              phase: 'uploading',
              status: 'Uploading 0%',
              canCancel: true,
            }))
          },
          onProgress: (progress) => {
            if (!isCurrentUpload()) {
              return
            }

            updateActiveUpload(queuedUpload.localId, (upload) => ({
              ...upload,
              phase: 'uploading',
              progress: progress.percent,
              uploadedBytes: progress.uploadedBytes,
              totalBytes: progress.totalBytes,
              bytesPerSecond: progress.bytesPerSecond,
              status: uploadStatusFromProgress(progress),
            }))
          },
        })

        if (!isCurrentUpload()) {
          return
        }

        onTaskSettled(mapTaskResponseToView(result.completedTask))
      } catch (error) {
        if (!isCurrentUpload() || isUploadAbortError(error)) {
          return
        }

        const errorCode = error instanceof ParseOtterApiError ? error.code : null
        const errorMessage = error instanceof UploadValidationError || error instanceof Error ? error.message : 'Upload failed. Please try again.'
        const activeUpload = activeUploadsRef.current.find((upload) => upload.localId === queuedUpload.localId)

        onTaskSettled(
          createFailedUploadTaskView({
            upload:
              activeUpload ?? {
                localId: queuedUpload.localId,
                taskId: null,
                fileName: queuedUpload.fileName,
                fileType: queuedUpload.fileType,
                fileSizeBytes: queuedUpload.fileSizeBytes,
              },
            errorCode,
            errorMessage,
          })
        )
      } finally {
        if (isCurrentUpload()) {
          abortControllersByLocalIdRef.current.delete(queuedUpload.localId)
          setActiveUploads((currentUploads) => currentUploads.filter((upload) => upload.localId !== queuedUpload.localId))
        }
      }
    },
    [api, getTurnstileToken, onTaskSettled, updateActiveUpload]
  )

  const startQueuedUpload = useCallback(
    (queuedUpload: QueuedUploadView): void => {
      const abortController = new AbortController()
      abortControllersByLocalIdRef.current.set(queuedUpload.localId, abortController)
      void runQueuedUpload(queuedUpload, abortController)
    },
    [runQueuedUpload]
  )

  useEffect(() => {
    if (queuedUploads.length === 0 || activeUploads.length >= FILE_UPLOAD_CONCURRENCY_LIMIT) {
      return
    }

    const uploadsToStart = queuedUploads.slice(0, FILE_UPLOAD_CONCURRENCY_LIMIT - activeUploads.length)
    const startingUploadIds = new Set(uploadsToStart.map((upload) => upload.localId))
    setQueuedUploads((currentUploads) => currentUploads.filter((upload) => !startingUploadIds.has(upload.localId)))
    setActiveUploads((currentUploads) => [...currentUploads, ...uploadsToStart.map(createActiveUploadView)])

    for (const upload of uploadsToStart) {
      startQueuedUpload(upload)
    }
  }, [activeUploads.length, queuedUploads, startQueuedUpload])

  const enqueueUploads = useCallback((files: QueuableSelectedFile[]): void => {
    if (files.length === 0) {
      return
    }

    setQueuedUploads((currentUploads) => [...currentUploads, ...files.map(createQueuedUploadView)])
  }, [])

  const handleCancelQueuedUpload = useCallback((localId: string): void => {
    setQueuedUploads((currentUploads) => currentUploads.filter((upload) => upload.localId !== localId))
  }, [])

  const handleCancelActiveUpload = useCallback(
    (localId: string): void => {
      const abortController = abortControllersByLocalIdRef.current.get(localId)
      if (!abortController) {
        return
      }

      updateActiveUpload(localId, (upload) => ({
        ...upload,
        status: 'Canceling upload',
        canCancel: false,
      }))
      abortController.abort()
    },
    [updateActiveUpload]
  )

  return {
    queuedUploads,
    activeUploads,
    enqueueUploads,
    handleCancelQueuedUpload,
    handleCancelActiveUpload,
  }
}
