import { ExternalLink, LockKeyhole, ShieldCheck } from 'lucide-react'

import { projectLinks } from '../project-links'
import './TrustPage.css'

export type TrustPageKind = 'privacy' | 'security'

function ExternalTextLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="trust-page-link" href={href} target="_blank" rel="noreferrer">
      <span>{children}</span>
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  )
}

function PrivacyPage() {
  return (
    <section className="trust-page" aria-labelledby="trust-page-title">
      <div className="trust-page-heading">
        <ShieldCheck size={24} aria-hidden="true" />
        <div>
          <p className="trust-page-kicker">Hosted service trust</p>
          <h1 id="trust-page-title">Privacy and retention</h1>
          <p>
            ParseOtter can be used for free at parseotter.com or self-hosted from the public repository when documents
            must stay in your own environment.
          </p>
        </div>
      </div>

      <div className="trust-page-sections">
        <section className="trust-page-section" aria-labelledby="privacy-storage-title">
          <h2 id="privacy-storage-title">What is stored</h2>
          <ul>
            <li>Uploaded source files and generated ZIP files are stored in Cloudflare R2 while results are available.</li>
            <li>Task metadata, lightweight usage records, and optional feedback are stored in Cloudflare D1.</li>
            <li>Your recent conversions list is stored only in this browser's local storage.</li>
          </ul>
        </section>

        <section className="trust-page-section" aria-labelledby="privacy-retention-title">
          <h2 id="privacy-retention-title">Retention</h2>
          <ul>
            <li>Hosted conversion results expire after 48 hours by default.</li>
            <li>Cleanup removes recorded input and output objects after expiration.</li>
            <li>Self-hosters control their own retention settings, logs, access controls, and privacy notices.</li>
          </ul>
        </section>
      </div>

      <div className="trust-page-actions">
        <ExternalTextLink href={projectLinks.selfHostingGuide}>Self-hosting guide</ExternalTextLink>
        <ExternalTextLink href={projectLinks.repository}>Source code</ExternalTextLink>
        <a className="trust-page-link trust-page-link-secondary" href="/">
          Back to converter
        </a>
      </div>
    </section>
  )
}

function SecurityPage() {
  return (
    <section className="trust-page" aria-labelledby="trust-page-title">
      <div className="trust-page-heading">
        <LockKeyhole size={24} aria-hidden="true" />
        <div>
          <p className="trust-page-kicker">Security</p>
          <h1 id="trust-page-title">Reporting and operating safely</h1>
          <p>
            ParseOtter is open source and self-hostable. Security-sensitive reports should use the private disclosure
            path, not public issues.
          </p>
        </div>
      </div>

      <div className="trust-page-sections">
        <section className="trust-page-section" aria-labelledby="security-reporting-title">
          <h2 id="security-reporting-title">Report security issues privately</h2>
          <ul>
            <li>Do not post vulnerabilities, exposed credentials, or private account details in public issues.</li>
            <li>Use GitHub private vulnerability reporting for security-sensitive reports.</li>
            <li>For ordinary bugs or conversion-quality problems, use the public issue templates or Feedback button.</li>
          </ul>
        </section>

        <section className="trust-page-section" aria-labelledby="security-controls-title">
          <h2 id="security-controls-title">Hosted and self-hosted controls</h2>
          <ul>
            <li>The hosted workflow uses short result retention, rate limits, Turnstile support, and signed Modal callbacks.</li>
            <li>Self-hosters must configure their own Cloudflare, Modal, R2, D1, CORS, secrets, access, and retention settings.</li>
            <li>Rotate secrets immediately if they are exposed, and avoid sharing real documents in public reproduction cases.</li>
          </ul>
        </section>
      </div>

      <div className="trust-page-actions">
        <ExternalTextLink href={projectLinks.privateSecurityReport}>Private security report</ExternalTextLink>
        <ExternalTextLink href={projectLinks.securityPolicy}>Security policy</ExternalTextLink>
        <ExternalTextLink href={projectLinks.selfHostingGuide}>Self-hosting guide</ExternalTextLink>
        <a className="trust-page-link trust-page-link-secondary" href="/">
          Back to converter
        </a>
      </div>
    </section>
  )
}

export function TrustPage({ kind }: { kind: TrustPageKind }) {
  return kind === 'privacy' ? <PrivacyPage /> : <SecurityPage />
}
