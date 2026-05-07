import { Clock3, Hourglass } from 'lucide-react'
import { useEffect, useState } from 'react'

import { filesHistoryCopy } from '../app-copy'
import { sortTasksByUploadTime, type RestoredTaskView } from '../task-view-mapping'
import type { ActiveUploadView, QueuedUploadView } from '../upload-queue'
import {
  ActiveUploadRow,
  getTaskGroupKey,
  getTaskSortTime,
  QueuedUploadRow,
  RestoredTaskRow,
  type TaskGroupKey,
} from './TaskRows'
import './FilesList.css'

type TaskGroup = {
  key: TaskGroupKey
  label: string
  tasks: RestoredTaskView[]
}

type FilesListItem =
  | {
      kind: 'active-upload'
      key: string
      groupKey: 'uploading'
      position: number
      sortTime: number
      upload: ActiveUploadView
    }
  | {
      kind: 'queued-upload'
      key: string
      groupKey: 'uploading'
      position: number
      sortTime: number
      upload: QueuedUploadView
    }
  | {
      kind: 'restored-task'
      key: string
      groupKey: TaskGroupKey
      position: number
      sortTime: number
      task: RestoredTaskView
    }

type FilesListGroup = {
  key: TaskGroupKey
  label: string
  items: FilesListItem[]
}

const RECENT_TASKS_PAGE_SIZE = 20

const TASK_GROUP_ORDER: Array<{ key: TaskGroupKey; label: string }> = [
  { key: 'uploading', label: 'Uploading' },
  { key: 'processing', label: 'Processing' },
  { key: 'completed', label: 'Results' },
  { key: 'failed', label: 'Failed' },
  { key: 'expired', label: 'Expired' },
]

function groupTasks(tasks: RestoredTaskView[]): TaskGroup[] {
  return TASK_GROUP_ORDER.map((group) => ({
    ...group,
    tasks: sortTasksByUploadTime(tasks.filter((task) => getTaskGroupKey(task) === group.key)),
  })).filter((group) => group.tasks.length > 0)
}

function orderTasksForRecentList(tasks: RestoredTaskView[]): RestoredTaskView[] {
  return groupTasks(tasks).flatMap((group) => group.tasks)
}

function paginateRecentTasks(tasks: RestoredTaskView[], page: number): RestoredTaskView[] {
  const startIndex = (page - 1) * RECENT_TASKS_PAGE_SIZE
  return tasks.slice(startIndex, startIndex + RECENT_TASKS_PAGE_SIZE)
}

function getActiveUploadItemKey(upload: ActiveUploadView): string {
  return upload.taskId ? `active:${upload.taskId}` : `active:${upload.localId}`
}

function createFilesListItems({
  queuedUploads,
  activeUploads,
  tasks,
}: {
  queuedUploads: QueuedUploadView[]
  activeUploads: ActiveUploadView[]
  tasks: RestoredTaskView[]
}): FilesListItem[] {
  const activeTaskIds = new Set(activeUploads.map((upload) => upload.taskId).filter((taskId): taskId is string => taskId !== null))
  const activeItems: FilesListItem[] = activeUploads.map((upload, index) => ({
    kind: 'active-upload',
    key: getActiveUploadItemKey(upload),
    groupKey: 'uploading',
    position: index,
    sortTime: Number.MAX_SAFE_INTEGER,
    upload,
  }))
  const queuedItems: FilesListItem[] = queuedUploads.map((upload, index) => ({
    kind: 'queued-upload',
    key: `queued:${upload.localId}`,
    groupKey: 'uploading',
    position: index,
    sortTime: Number.MAX_SAFE_INTEGER - 1,
    upload,
  }))
  const restoredItems: FilesListItem[] = tasks
    .filter((task) => !activeTaskIds.has(task.taskId))
    .map((task, index) => ({
      kind: 'restored-task',
      key: `task:${task.taskId}`,
      groupKey: getTaskGroupKey(task),
      position: index,
      sortTime: getTaskSortTime(task),
      task,
    }))

  return [...activeItems, ...queuedItems, ...restoredItems]
}

const FILE_LIST_KIND_ORDER: Record<FilesListItem['kind'], number> = {
  'active-upload': 0,
  'queued-upload': 1,
  'restored-task': 2,
}

function sortFilesListItems(items: FilesListItem[]): FilesListItem[] {
  return [...items].sort((left, right) => {
    const kindDifference = FILE_LIST_KIND_ORDER[left.kind] - FILE_LIST_KIND_ORDER[right.kind]
    if (kindDifference !== 0) {
      return kindDifference
    }

    if (left.kind !== 'restored-task' || right.kind !== 'restored-task') {
      return left.position - right.position
    }

    const timeDifference = right.sortTime - left.sortTime
    return timeDifference === 0 ? left.key.localeCompare(right.key) : timeDifference
  })
}

function groupFilesListItems(items: FilesListItem[]): FilesListGroup[] {
  return TASK_GROUP_ORDER.map((group) => ({
    ...group,
    items: sortFilesListItems(items.filter((item) => item.groupKey === group.key)),
  })).filter((group) => group.items.length > 0)
}

function FilesListItemRow({
  item,
  onCancelQueuedUpload,
  onCancelActiveUpload,
  onDownloadTask,
  onPreviewTask,
}: {
  item: FilesListItem
  onCancelQueuedUpload: (localId: string) => void
  onCancelActiveUpload: (localId: string) => void
  onDownloadTask: (task: RestoredTaskView) => void
  onPreviewTask: (task: RestoredTaskView) => void
}) {
  if (item.kind === 'active-upload') {
    return <ActiveUploadRow upload={item.upload} onCancelUpload={onCancelActiveUpload} />
  }

  if (item.kind === 'queued-upload') {
    return <QueuedUploadRow upload={item.upload} onCancelUpload={onCancelQueuedUpload} />
  }

  return <RestoredTaskRow task={item.task} onDownloadTask={onDownloadTask} onPreviewTask={onPreviewTask} />
}

export function FilesList({
  queuedUploads,
  activeUploads,
  tasks,
  onCancelQueuedUpload,
  onCancelActiveUpload,
  onDownloadTask,
  onPreviewTask,
}: {
  queuedUploads: QueuedUploadView[]
  activeUploads: ActiveUploadView[]
  tasks: RestoredTaskView[]
  onCancelQueuedUpload: (localId: string) => void
  onCancelActiveUpload: (localId: string) => void
  onDownloadTask: (task: RestoredTaskView) => void
  onPreviewTask: (task: RestoredTaskView) => void
}) {
  const orderedTasks = orderTasksForRecentList(tasks)
  const totalPages = Math.max(1, Math.ceil(orderedTasks.length / RECENT_TASKS_PAGE_SIZE))
  const [currentPage, setCurrentPage] = useState(1)
  const effectivePage = Math.min(currentPage, totalPages)

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages))
  }, [totalPages])

  const pagedTasks = paginateRecentTasks(orderedTasks, effectivePage)
  const filesListItems = createFilesListItems({
    queuedUploads,
    activeUploads,
    tasks: pagedTasks,
  })
  const filesListGroups = groupFilesListItems(filesListItems)
  const hasAnyVisibleTasks = filesListGroups.length > 0
  const rangeStart = orderedTasks.length === 0 ? 0 : (effectivePage - 1) * RECENT_TASKS_PAGE_SIZE + 1
  const rangeEnd = orderedTasks.length === 0 ? 0 : rangeStart + pagedTasks.length - 1

  return (
    <section className="restored-stack" aria-labelledby="restored-title">
      <div className="restored-heading">
        <h2 id="restored-title">Files</h2>
        <p className="restored-heading-note">
          <Clock3 size={13} aria-hidden="true" />
          <span>{filesHistoryCopy.headingNote}</span>
        </p>
      </div>
      <div className="task-list" aria-live="polite">
        {hasAnyVisibleTasks ? (
          <>
            {filesListGroups.map((group) => (
              <section className="task-group" role="group" aria-label={`${group.label} tasks`} key={group.key}>
                <h3 className="task-group-title">{group.label}</h3>
                {group.items.map((item) => (
                  <FilesListItemRow
                    item={item}
                    onCancelQueuedUpload={onCancelQueuedUpload}
                    onCancelActiveUpload={onCancelActiveUpload}
                    onDownloadTask={onDownloadTask}
                    onPreviewTask={onPreviewTask}
                    key={item.key}
                  />
                ))}
              </section>
            ))}
          </>
        ) : (
          <div className="task-row task-row-empty">
            <div className="task-file">
              <Hourglass size={19} aria-hidden="true" />
              <span>{filesHistoryCopy.emptyState}</span>
            </div>
          </div>
        )}
      </div>
      {orderedTasks.length > RECENT_TASKS_PAGE_SIZE ? (
        <div className="restored-pagination" aria-label="Recent task pages">
          <span className="restored-pagination-summary">
            Showing {rangeStart}-{rangeEnd} of {orderedTasks.length}
          </span>
          <div className="restored-pagination-controls">
            <button
              className="pagination-button"
              type="button"
              aria-label="Previous page"
              disabled={effectivePage === 1}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            >
              Previous
            </button>
            <span className="restored-pagination-page">
              Page {effectivePage} of {totalPages}
            </span>
            <button
              className="pagination-button"
              type="button"
              aria-label="Next page"
              disabled={effectivePage === totalPages}
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
