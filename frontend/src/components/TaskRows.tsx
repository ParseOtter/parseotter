import { Check, Download, ExternalLink, Eye, Hourglass, X } from 'lucide-react'

import { getDocumentKind, getDocumentKindLabel, type DocumentKind } from '../document-format'
import { formatBytes, formatSpeed } from '../format'
import { projectLinks } from '../project-links'
import {
  formatActiveUploadMeta,
  formatCompletedTaskResultMeta,
  formatTaskUploadMeta,
  PROCESSING_TASK_STATUSES,
  type RestoredTaskView,
} from '../task-view-mapping'
import { isFreeHostedLimitErrorCode, type ActiveUploadView, type QueuedUploadView } from '../upload-queue'
import './TaskRows.css'

export type TaskGroupKey = 'uploading' | 'processing' | 'completed' | 'failed' | 'expired'
type DocumentState = 'success' | 'error' | 'live' | 'queued'

export function getTaskGroupKey(task: RestoredTaskView): TaskGroupKey {
  if (task.status === 'expired') {
    return 'expired'
  }

  if (task.status === 'succeeded') {
    return 'completed'
  }

  if (task.status === 'failed') {
    return 'failed'
  }

  return PROCESSING_TASK_STATUSES.has(task.status) ? 'processing' : 'uploading'
}

export function getTaskSortTime(task: RestoredTaskView): number {
  if (task.createdAt && Number.isFinite(Date.parse(task.createdAt))) {
    return Date.parse(task.createdAt)
  }

  return Number.isFinite(Date.parse(task.expiresAt)) ? Date.parse(task.expiresAt) : 0
}

function getTaskDocumentState(task: RestoredTaskView): DocumentState {
  if (task.status === 'succeeded') {
    return 'success'
  }

  if (task.status === 'failed' || task.status === 'expired') {
    return 'error'
  }

  return 'live'
}

function DocumentStateIcon({ state }: { state: DocumentState }) {
  if (state === 'success') {
    return <Check size={11} strokeWidth={3} aria-hidden="true" />
  }

  if (state === 'error') {
    return <X size={11} strokeWidth={3} aria-hidden="true" />
  }

  return <Hourglass size={10} strokeWidth={2.8} aria-hidden="true" />
}

function DocumentIdentityBadge({
  fileName,
  fileType,
  state,
}: {
  fileName: string
  fileType?: string | null
  state: DocumentState
}) {
  const documentKind: DocumentKind = getDocumentKind({ fileName, fileType })
  const documentLabel = getDocumentKindLabel(documentKind)

  return (
    <span
      className={`document-identity document-identity-${documentKind} document-identity-state-${state}`}
      aria-label={`${documentLabel} file`}
      title={`${documentLabel} file`}
    >
      <span className="document-identity-label">{documentLabel}</span>
      <span className="document-identity-state" aria-hidden="true">
        <DocumentStateIcon state={state} />
      </span>
    </span>
  )
}

function getRestoredTaskActionStatus(task: RestoredTaskView): string {
  const groupKey = getTaskGroupKey(task)

  if (groupKey === 'processing') {
    return 'Processing'
  }

  return task.visibleStatus
}

function getRestoredTaskFailureReason(task: RestoredTaskView): string | null {
  if (task.status !== 'failed' && task.status !== 'expired') {
    return null
  }

  return task.errorMessage
}

function RestoredTaskProgress({ task }: { task: RestoredTaskView }) {
  return (
    <span
      className="task-progress-track task-progress-track-indeterminate"
      role="progressbar"
      aria-label={`Processing progress for ${task.fileName}`}
    >
      <span className="task-progress-value task-progress-indeterminate" />
    </span>
  )
}

function getProcessingTaskStatusText(task: RestoredTaskView): string {
  if (task.refreshErrorMessage) {
    return task.refreshErrorMessage
  }

  if (task.status === 'processing') {
    return 'Building ZIP output'
  }

  if (task.status === 'dispatching') {
    return 'Converting'
  }

  if (task.status === 'dispatch_pending' || task.status === 'upload_completed') {
    return 'Waiting for conversion'
  }

  return task.visibleStatus
}

export function RestoredTaskRow({
  task,
  onDownloadTask,
  onPreviewTask,
}: {
  task: RestoredTaskView
  onDownloadTask: (task: RestoredTaskView) => void
  onPreviewTask: (task: RestoredTaskView) => void
}) {
  const groupKey = getTaskGroupKey(task)
  const failureReason = getRestoredTaskFailureReason(task)
  const isFreeHostedLimit = isFreeHostedLimitErrorCode(task.errorCode)

  return (
    <div
      className={`task-row ${
        task.status === 'succeeded'
          ? 'task-row-success'
          : task.status === 'failed' || task.status === 'expired'
            ? 'task-row-error'
            : 'task-row-neutral'
      }`}
    >
      <div className="task-file">
        <DocumentIdentityBadge fileName={task.fileName} fileType={task.fileType} state={getTaskDocumentState(task)} />
        <span className="task-copy">
          <span className="task-name">{task.fileName}</span>
          <span className="task-meta">{formatTaskUploadMeta(task)}</span>
          {groupKey === 'completed' ? <span className="task-meta">{formatCompletedTaskResultMeta(task)}</span> : null}
          {groupKey === 'processing' ? (
            <>
              <span className="task-meta">{getProcessingTaskStatusText(task)}</span>
              <RestoredTaskProgress task={task} />
            </>
          ) : null}
          {failureReason ? <span className="task-meta">{failureReason}</span> : null}
        </span>
      </div>
      <div className="task-actions">
        {task.canDownload ? (
          <>
            <button
              className="secondary-button-compact"
              type="button"
              aria-label={`Preview converted Markdown for ${task.fileName}`}
              disabled={task.isDownloading}
              onClick={() => onPreviewTask(task)}
            >
              <Eye size={15} aria-hidden="true" />
              Preview
            </button>
            <button
              className="download-button"
              type="button"
              aria-label={`Download converted Markdown for ${task.fileName}`}
              disabled={task.isDownloading}
              onClick={() => onDownloadTask(task)}
            >
              <Download size={15} aria-hidden="true" />
              Download
            </button>
          </>
        ) : isFreeHostedLimit ? (
          <>
            <span className="task-status">{getRestoredTaskActionStatus(task)}</span>
            <a
              className="secondary-button-compact"
              href={projectLinks.selfHostingGuide}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} aria-hidden="true" />
              Self-host
            </a>
          </>
        ) : (
          <span className="task-status">{getRestoredTaskActionStatus(task)}</span>
        )}
      </div>
    </div>
  )
}

export function ActiveUploadRow({
  upload,
  onCancelUpload,
}: {
  upload: ActiveUploadView
  onCancelUpload: (localId: string) => void
}) {
  return (
    <div className="task-row task-row-neutral" key={upload.localId}>
      <div className="task-file">
        <DocumentIdentityBadge fileName={upload.fileName} fileType={upload.fileType} state="live" />
        <span className="task-copy">
          <span className="task-name">{upload.fileName}</span>
          <span className="task-meta">{formatActiveUploadMeta(upload)}</span>
          {upload.bytesPerSecond ? <span className="task-meta">Uploaded at {formatSpeed(upload.bytesPerSecond)}</span> : null}
          {upload.errorMessage ? <span className="task-meta">{upload.errorMessage}</span> : null}
          <span
            className="task-progress-track"
            role="progressbar"
            aria-label={`Upload progress for ${upload.fileName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={upload.progress}
          >
            <span className="task-progress-value" style={{ width: `${upload.progress}%` }} />
          </span>
        </span>
      </div>
      <div className="task-actions">
        <span className="task-status">{upload.status}</span>
        <button
          className="icon-button"
          type="button"
          aria-label={`Cancel upload for ${upload.fileName}`}
          disabled={!upload.canCancel}
          onClick={() => onCancelUpload(upload.localId)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export function QueuedUploadRow({
  upload,
  onCancelUpload,
}: {
  upload: QueuedUploadView
  onCancelUpload: (localId: string) => void
}) {
  return (
    <div className="task-row task-row-neutral" key={upload.localId}>
      <div className="task-file">
        <DocumentIdentityBadge fileName={upload.fileName} fileType={upload.fileType} state="queued" />
        <span className="task-copy">
          <span className="task-name">{upload.fileName}</span>
          <span className="task-meta">{formatBytes(upload.fileSizeBytes)} · Waiting for an upload slot</span>
        </span>
      </div>
      <div className="task-actions">
        <span className="task-status">{upload.message}</span>
        <button
          className="icon-button"
          type="button"
          aria-label={`Cancel upload for ${upload.fileName}`}
          onClick={() => onCancelUpload(upload.localId)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
