import { useCallback, useRef, useState } from 'react'

import { trackBeginConversion, trackFileSelected } from './analytics'
import { createFileIdentity, findDuplicateFileMatch, type SelectedFileView } from './duplicate-detection'
import { resolveFileType, validateUploadFile } from './multipart-uploader'
import { loadStoredTasks } from './task-storage'
import { mapStoredTaskToView, mergeTaskViews, type RestoredTaskView } from './task-view-mapping'
import type { ActiveUploadView, QueuedUploadView } from './upload-queue'

type UseFileSelectionInput = {
  restoredTasks: RestoredTaskView[]
  queuedUploads: QueuedUploadView[]
  activeUploads: ActiveUploadView[]
  onStartProcessing: (files: SelectedFileView[]) => void
}

export function useFileSelection(input: UseFileSelectionInput) {
  const { restoredTasks, queuedUploads, activeUploads, onStartProcessing } = input
  const selectedFileSequenceRef = useRef(0)
  const [selectedFiles, setSelectedFiles] = useState<SelectedFileView[]>([])

  const createSelectedFileView = useCallback(
    (params: {
      file: File
      seenFileIdentities: Set<string>
      duplicateTasks: RestoredTaskView[]
      queuedUploads: QueuedUploadView[]
      activeUploads: ActiveUploadView[]
    }): SelectedFileView => {
      selectedFileSequenceRef.current += 1
      const localId = `selected_file_${selectedFileSequenceRef.current}`
      const baseView = {
        localId,
        file: params.file,
        fileName: params.file.name,
        fileSizeBytes: params.file.size,
      }

      try {
        validateUploadFile(params.file)
      } catch (error) {
        return {
          ...baseView,
          status: 'invalid',
          message: error instanceof Error ? error.message : 'Choose a PDF or EPUB file.',
          duplicateTaskId: null,
        }
      }

      const fileIdentity = createFileIdentity({
        fileName: params.file.name,
        fileSizeBytes: params.file.size,
      })

      if (params.seenFileIdentities.has(fileIdentity)) {
        return {
          ...baseView,
          status: 'duplicate',
          message: 'Duplicate in selection',
          duplicateTaskId: null,
        }
      }

      params.seenFileIdentities.add(fileIdentity)

      const duplicateMatch = findDuplicateFileMatch(params.file, {
        queuedUploads: params.queuedUploads,
        activeUploads: params.activeUploads,
        restoredTasks: params.duplicateTasks,
      })
      if (duplicateMatch) {
        return {
          ...baseView,
          status: 'duplicate',
          message: duplicateMatch.message,
          duplicateTaskId: duplicateMatch.taskId,
        }
      }

      return {
        ...baseView,
        status: 'ready',
        message: null,
        duplicateTaskId: null,
      }
    },
    []
  )

  const handleFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0) {
        return
      }

      for (const file of files) {
        trackFileSelected({
          fileType: resolveFileType(file) ?? 'unsupported',
          fileSizeBytes: file.size,
        })
      }

      const storedTasks = loadStoredTasks().map(mapStoredTaskToView)
      const duplicateTasks = mergeTaskViews(restoredTasks, storedTasks)

      setSelectedFiles((currentFiles) => {
        const seenFileIdentities = new Set(
          currentFiles.map((file) =>
            createFileIdentity({
              fileName: file.fileName,
              fileSizeBytes: file.fileSizeBytes,
            })
          )
        )

        const nextFiles = files.map((file) =>
          createSelectedFileView({
            file,
            seenFileIdentities,
            duplicateTasks,
            queuedUploads,
            activeUploads,
          })
        )

        return [...currentFiles, ...nextFiles]
      })
    },
    [activeUploads, createSelectedFileView, queuedUploads, restoredTasks]
  )

  const removeSelectedFile = useCallback((localId: string): void => {
    setSelectedFiles((currentFiles) => currentFiles.filter((file) => file.localId !== localId))
  }, [])

  const clearSelectedFiles = useCallback((): void => {
    setSelectedFiles([])
  }, [])

  const handleStartProcessing = useCallback((): void => {
    const readyFiles = selectedFiles.filter((file) => file.status === 'ready')
    if (readyFiles.length === 0) {
      return
    }

    trackBeginConversion({ fileCount: readyFiles.length })
    onStartProcessing(readyFiles)

    const readyFileIds = new Set(readyFiles.map((file) => file.localId))
    setSelectedFiles((currentFiles) => currentFiles.filter((file) => !readyFileIds.has(file.localId)))
  }, [onStartProcessing, selectedFiles])

  return {
    selectedFiles,
    handleFiles,
    removeSelectedFile,
    clearSelectedFiles,
    handleStartProcessing,
  }
}
