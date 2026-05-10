import { ExternalLink, ShieldCheck, X } from 'lucide-react'

import { projectLinks } from '../project-links'
import { DialogShell } from './DialogShell'
import './InfoDialog.css'

export type InfoDialogKind = 'privacy'

type InfoDialogProps = {
  kind: InfoDialogKind | null
  onClose: () => void
}

function ExternalTextLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="info-link" href={href} target="_blank" rel="noreferrer">
      <span>{children}</span>
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  )
}

function PrivacyContent() {
  return (
    <>
      <div className="info-intro">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <h2>Privacy and retention</h2>
          <p>
            ParseOtter can be used for free at parseotter.com or self-hosted from the public repository when documents
            must stay in your own environment.
          </p>
        </div>
      </div>
      <ul className="info-list">
        <li>Uploaded source files and generated ZIP files are retained for up to 48 hours by default, then removed.</li>
        <li>Task metadata, lightweight usage records, and optional feedback are stored to operate and improve the service.</li>
        <li>Your recent conversions list is stored in this browser only, so other browsers cannot see it.</li>
      </ul>
      <div className="info-actions">
        <ExternalTextLink href={projectLinks.selfHostingGuide}>Self-hosting guide</ExternalTextLink>
        <ExternalTextLink href={projectLinks.repository}>Source code</ExternalTextLink>
      </div>
    </>
  )
}

export function InfoDialog({ kind, onClose }: InfoDialogProps) {
  if (!kind) {
    return null
  }

  return (
    <DialogShell
      open
      onClose={onClose}
      ariaLabel="ParseOtter privacy information"
      backdropClassName="info-backdrop"
      dialogClassName="info-dialog"
    >
      <div className="info-header">
        <span>Privacy</span>
        <button className="info-close" type="button" onClick={onClose} aria-label="Close dialog" data-close-button>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="info-body">
        <PrivacyContent />
      </div>
    </DialogShell>
  )
}
