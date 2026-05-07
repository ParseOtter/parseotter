import { useCallback, useEffect, useRef, useState } from 'react'

import { trackDownloadResult } from './analytics'
import type { ParseOtterApiClient } from './parseotter-api'
import { loadStoredTasks, removeStoredTask, saveStoredTask } from './task-storage'
import { isTaskNotFoundRefreshError, mapDownloadErrorToTask, mapRefreshErrorToTask } from './task-refresh'
import {
  isActiveTask,
  mapStoredTaskToView,
  mapTaskResponseToView,
  mapViewToStoredTask,
  shouldPersistTask,
  sortTasksByUploadTime,
  updateTaskList,
  type RestoredTaskView,
} from './task-view-mapping'

const POLL_INTERVAL_MS = 5000

type UseTaskPersistenceInput = {
  api: ParseOtterApiClient
}

export function useTaskPersistence(input: UseTaskPersistenceInput) {
  const { api } = input
  const [restoredTasks, setRestoredTasks] = useState<RestoredTaskView[]>(() =>
    sortTasksByUploadTime(loadStoredTasks().map(mapStoredTaskToView))
  )
  const restoredTasksRef = useRef<RestoredTaskView[]>(restoredTasks)

  useEffect(() => {
    restoredTasksRef.current = restoredTasks
  }, [restoredTasks])

  const upsertTask = useCallback((nextTask: RestoredTaskView): void => {
    if (shouldPersistTask(nextTask)) {
      saveStoredTask(mapViewToStoredTask(nextTask))
    } else {
      removeStoredTask(nextTask.taskId)
    }

    setRestoredTasks((tasks) => updateTaskList(tasks, nextTask))
  }, [])

  const refreshTask = useCallback(
    async (taskId: string): Promise<void> => {
      try {
        const task = await api.getTask(taskId)
        const nextTask = mapTaskResponseToView(task)
        if (shouldPersistTask(nextTask)) {
          saveStoredTask(mapViewToStoredTask(nextTask))
          setRestoredTasks((currentTasks) => updateTaskList(currentTasks, nextTask))
          return
        }

        removeStoredTask(taskId)
        setRestoredTasks((currentTasks) => currentTasks.filter((item) => item.taskId !== taskId))
      } catch (error) {
        if (isTaskNotFoundRefreshError(error)) {
          removeStoredTask(taskId)
          setRestoredTasks((currentTasks) => currentTasks.filter((task) => task.taskId !== taskId))
          return
        }

        setRestoredTasks((currentTasks) =>
          sortTasksByUploadTime(currentTasks.map((task) => (task.taskId === taskId ? mapRefreshErrorToTask(task, error) : task)))
        )
      }
    },
    [api]
  )

  useEffect(() => {
    for (const task of loadStoredTasks()) {
      void refreshTask(task.taskId)
    }
  }, [refreshTask])

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const task of restoredTasksRef.current.filter(isActiveTask)) {
        void refreshTask(task.taskId)
      }
    }, POLL_INTERVAL_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [refreshTask])

  const handleDownloadTask = useCallback(
    async (task: RestoredTaskView): Promise<void> => {
      setRestoredTasks((tasks) =>
        tasks.map((item) =>
          item.taskId === task.taskId
            ? {
                ...item,
                isDownloading: true,
              }
            : item
        )
      )

      try {
        const download = await api.getDownload(task.taskId)
        setRestoredTasks((tasks) =>
          tasks.map((item) =>
            item.taskId === task.taskId
              ? {
                  ...item,
                  isDownloading: false,
                  errorMessage: null,
                }
              : item
          )
        )
        trackDownloadResult({ status: 'success' })
        window.open(download.url, '_self', 'noopener')
      } catch (error) {
        trackDownloadResult({ status: 'error' })
        setRestoredTasks((tasks) => tasks.map((item) => (item.taskId === task.taskId ? mapDownloadErrorToTask(item, error) : item)))
      }
    },
    [api]
  )

  return {
    restoredTasks,
    upsertTask,
    handleDownloadTask,
  }
}
