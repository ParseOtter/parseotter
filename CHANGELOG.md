# Changelog

All notable changes to ParseOtter will be documented in this file.

## v0.1.2 - 2026-05-12

Open-source release and deployment process maintenance.

### Changed

- Clarified `DEPLOYMENT.md` as the self-hosted manual deployment path and documented how hosted ParseOtter production workflows differ from self-hosted deployments.
- Corrected frontend self-host deployment commands so Vite production variables are present when the final Worker asset build runs.
- Expanded self-host deployment guidance for Turnstile, GA4, Cloudflare Rate Limiting namespace IDs, and production acceptance checks.
- Removed hard-coded historical production resource names from public production deployment workflows while preserving GitHub environment based deployment targeting.
- Automated GitHub release publishing so maintainers can create an annotated tag and GitHub Release from a manually confirmed workflow after CI and Security Scan pass.

### Fixed

- Fixed the issue template security report contact link so it points to ParseOtter's private vulnerability reporting URL.

### Release Verification

- GitHub Actions CI passed on the release base commit.
- GitHub Security Scan passed on the release base commit.
- Hosted frontend production deployment passed after the workflow guardrail cleanup.
- `www.parseotter.com`, `api.parseotter.com/health`, public deployment docs, issue templates, and production workflow files were checked after the public maintenance updates.

## v0.1.1 - 2026-05-10

Public release surface refresh.

### Changed

- Polished README and deployment documentation to make the free hosted service, self-hosting path, architecture, and privacy/retention model clearer.
- Updated subproject READMEs so frontend, API Worker, and Modal converter documentation use consistent hosted-service and self-hosting language.
- Refreshed ParseOtter branding assets, app icons, favicon, upload screenshot, and architecture diagram.
- Updated the hosted frontend to use the ParseOtter icon in the product header and browser icons.
- Clarified GitHub repository metadata recommendations.

### Release Verification

- GitHub Actions CI passed on the release base commit.
- GitHub Security Scan passed on the release base commit.
- Hosted production conversion was verified through the real browser flow after the current public code was deployed.
- README, deployment guide, screenshot, architecture diagram, and flow recording were verified from GitHub raw assets.

## v0.1.0 - 2026-05-08

Initial open-source release.

### Included

- React frontend for PDF/EPUB upload, local task history, Markdown preview, and ZIP download.
- Cloudflare Worker API for task orchestration, R2 multipart upload, status polling, feedback, and downloads.
- D1 schema for ParseOtter task state, usage, abuse counters, feedback, and retention metadata.
- Durable Object coordination for per-task workflows.
- Modal GPU converter using `marker-pdf`.
- HMAC-signed Modal callbacks.
- Synthetic test fixtures and public release assets.
- Self-hosting deployment documentation.

### Release Verification

- Frontend, API Worker, and Modal converter tests passed before release.
- Public-tree scans covered secrets, obsolete names, generated files, and non-English public docs.
- Private release planning trackers were removed from the public tree before publishing.
