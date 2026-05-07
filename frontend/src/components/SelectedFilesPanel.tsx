import { Download, X } from 'lucide-react'

import { formatBytes } from '../format'
import type { SelectedFileView } from '../duplicate-detection'
import type { RestoredTaskView } from '../task-view-mapping'
import './SelectedFilesPanel.css'

export function SelectedFilesPanel({
  files,
  tasks,
  onRemoveFile,
  onClearFiles,
  onStartProcessing,
  onDownloadTask,
}: {
  files: SelectedFileView[]
  tasks: RestoredTaskView[]
  onRemoveFile: (localId: string) => void
  onClearFiles: () => void
  onStartProcessing: () => void
  onDownloadTask: (task: RestoredTaskView) => void
}) {
  if (files.length === 0) {
    return null
  }

  const readyFileCount = files.filter((file) => file.status === 'ready').length

  return (
    <section className="selected-files" aria-label="Selected files">
      <div className="selected-files-heading">
        <h2>Selected files</h2>
        <span>{readyFileCount} ready</span>
      </div>
      <div className="selected-file-list">
        {files.map((file) => {
          const duplicateTask = file.duplicateTaskId ? tasks.find((task) => task.taskId === file.duplicateTaskId) ?? null : null

          return (
            <div className={`selected-file-row selected-file-row-${file.status}`} key={file.localId}>
              <div className="selected-file-copy">
                <span className="selected-file-name">{file.fileName}</span>
                <span className="selected-file-meta">
                  <span>{formatBytes(file.fileSizeBytes)}</span>
                  {file.message ? <span>{file.message}</span> : null}
                </span>
              </div>
              <div className="selected-file-actions">
                <span className="selected-file-status">
                  {file.status === 'ready' ? 'Ready' : file.status === 'duplicate' ? 'Duplicate' : 'Invalid'}
                </span>
                {duplicateTask?.canDownload ? (
                  <button
                    className="secondary-button secondary-button-compact"
                    type="button"
                    aria-label={`Download existing converted Markdown for ${file.fileName}`}
                    disabled={duplicateTask.isDownloading}
                    onClick={() => onDownloadTask(duplicateTask)}
                  >
                    <Download size={14} aria-hidden="true" />
                    Download existing
                  </button>
                ) : null}
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove ${file.fileName}`}
                  onClick={() => onRemoveFile(file.localId)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="selected-files-controls">
        <button className="primary-button" type="button" disabled={readyFileCount === 0} onClick={onStartProcessing}>
          Start processing
        </button>
        <button className="secondary-button" type="button" onClick={onClearFiles}>
          Clear selection
        </button>
      </div>
    </section>
  )
}
