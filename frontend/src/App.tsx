import { FileText, FolderArchive, Github, Info, MessageSquare, ShieldCheck } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'

import { conversionLimits, uploadIntro } from './app-copy'
import { FilesList } from './components/FilesList'
import { FeedbackDialog } from './components/FeedbackDialog'
import { InfoDialog, type InfoDialogKind } from './components/InfoDialog'
import { PreviewDialog } from './components/PreviewDialog'
import { SelectedFilesPanel } from './components/SelectedFilesPanel'
import { PARSEOTTER_API_BASE_URL } from './config'
import { projectLinks } from './project-links'
import type { RestoredTaskView } from './task-view-mapping'
import { useParseOtterWorkflow } from './use-parseotter-workflow'
import './styles/App.css'

function ProductMark() {
  return (
    <span className="brand-icon" aria-hidden="true">
      <img src="/icon-192.png" alt="" />
    </span>
  )
}

function ProductHeader({ onOpenFeedback }: { onOpenFeedback: () => void }) {
  return (
    <header className="top-bar" data-api-base-url={PARSEOTTER_API_BASE_URL}>
      <div className="brand-lockup">
        <ProductMark />
        <span className="brand-copy">
          <span className="brand-name">ParseOtter</span>
          <span className="product-name">Convert</span>
        </span>
      </div>
      <div className="top-actions">
        <a className="top-action" href={projectLinks.repository} target="_blank" rel="noreferrer">
          <Github size={16} aria-hidden="true" />
          <span>GitHub</span>
        </a>
        <button className="feedback-trigger" type="button" onClick={onOpenFeedback}>
          <MessageSquare size={16} aria-hidden="true" />
          <span>Feedback</span>
        </button>
      </div>
    </header>
  )
}

function ConstraintPill({
  label,
  value,
  children,
}: {
  label: string
  value: string
  children: ReactNode
}) {
  return (
    <span className="constraint-pill">
      {children}
      <span className="constraint-copy">
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
    </span>
  )
}

function UploadGlyph() {
  return (
    <svg className="status-icon upload-icon" width="42" height="42" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        className="upload-cloud"
        d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <g className="upload-arrow">
        <path
          d="M12 13v8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
        <path
          d="m8 17 4-4 4 4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </g>
    </svg>
  )
}

export default function App() {
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false)
  const [infoDialog, setInfoDialog] = useState<InfoDialogKind | null>(null)
  const [previewTask, setPreviewTask] = useState<RestoredTaskView | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    selectedFiles,
    queuedUploads,
    activeUploads,
    restoredTasks,
    api,
    handleFiles,
    removeSelectedFile,
    clearSelectedFiles,
    handleStartProcessing,
    handleCancelQueuedUpload,
    handleCancelActiveUpload,
    handleDownloadTask,
  } = useParseOtterWorkflow()
  const hasCurrentFiles = selectedFiles.length > 0 || queuedUploads.length > 0 || activeUploads.length > 0

  return (
    <>
      <ProductHeader onOpenFeedback={() => setIsFeedbackOpen(true)} />
      <main className="page-shell">
        <section className="upload-stack" aria-labelledby="upload-title">
          <div className="work-panel">
            <div className="section-heading">
              <h1 id="upload-title">{uploadIntro.title}</h1>
              <p>
                {uploadIntro.descriptionLines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </p>
              <p className="trust-note">
                <ShieldCheck size={14} aria-hidden="true" />
                <span>Free to use at parseotter.com, open source on GitHub, and self-hostable for private workflows.</span>
              </p>
            </div>

            <div
              className={hasCurrentFiles ? 'drop-zone' : 'drop-zone drop-zone-idle'}
              role="group"
              aria-label="Upload PDF or EPUB files"
              onDragOver={(event) => {
                event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                handleFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <UploadGlyph />
              <h2>Drag and drop files here</h2>
              <p>or</p>
              <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                Choose Files
              </button>
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                multiple
                accept=".pdf,.epub,application/pdf,application/epub+zip"
                aria-label="Choose PDF or EPUB files"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? [])
                  event.currentTarget.value = ''
                  handleFiles(files)
                }}
              />
            </div>

            <div className="format-row" aria-label="Supported file constraints">
              <ConstraintPill label="Supported Formats" value={conversionLimits.acceptedFormats}>
                <FileText size={15} aria-hidden="true" />
              </ConstraintPill>
              <ConstraintPill label="Size limit" value={conversionLimits.maxFileSize}>
                <Info size={14} aria-hidden="true" />
              </ConstraintPill>
              <ConstraintPill label="Output" value={conversionLimits.zipOutput}>
                <FolderArchive size={15} aria-hidden="true" />
              </ConstraintPill>
            </div>

            <SelectedFilesPanel
              files={selectedFiles}
              tasks={restoredTasks}
              onRemoveFile={removeSelectedFile}
              onClearFiles={clearSelectedFiles}
              onStartProcessing={handleStartProcessing}
              onDownloadTask={handleDownloadTask}
            />
          </div>

          <FilesList
            queuedUploads={queuedUploads}
            activeUploads={activeUploads}
            tasks={restoredTasks}
            onCancelQueuedUpload={handleCancelQueuedUpload}
            onCancelActiveUpload={handleCancelActiveUpload}
            onDownloadTask={handleDownloadTask}
            onPreviewTask={setPreviewTask}
          />
        </section>
      </main>
      <footer className="operational-note">
        <span>{conversionLimits.availability}</span>
        <span className="footer-line">
          Copyright 2026 ParseOtter. Open source under{' '}
          <a href={projectLinks.license} target="_blank" rel="noreferrer">
            AGPL-3.0
          </a>
          .
        </span>
        <span className="footer-links">
          <a href={projectLinks.repository} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={projectLinks.selfHostingGuide} target="_blank" rel="noreferrer">
            Self-host
          </a>
          <button type="button" onClick={() => setInfoDialog('privacy')}>
            Privacy
          </button>
        </span>
      </footer>
      <FeedbackDialog open={isFeedbackOpen} onClose={() => setIsFeedbackOpen(false)} />
      <InfoDialog kind={infoDialog} onClose={() => setInfoDialog(null)} />
      {previewTask && (
        <PreviewDialog
          task={previewTask}
          api={api}
          onClose={() => setPreviewTask(null)}
          onDownload={(task) => {
            void handleDownloadTask(task)
          }}
        />
      )}
    </>
  )
}
