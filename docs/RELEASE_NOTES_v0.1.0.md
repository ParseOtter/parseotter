# ParseOtter v0.1.0

Initial open-source release of ParseOtter, a self-hostable PDF/EPUB-to-Markdown conversion service.

## Highlights

- React frontend for browser PDF/EPUB upload, local task history, Markdown preview, and ZIP download.
- Cloudflare Worker API for task creation, multipart upload orchestration, status polling, feedback, and downloads.
- Cloudflare D1 schema for task state, feedback, usage counters, abuse counters, and retention metadata.
- Cloudflare R2 storage for source files and result ZIPs under `parseotter/{taskId}/...`.
- Durable Object coordination for per-task workflows.
- Modal GPU converter powered by `marker-pdf`.
- HMAC-signed Modal callbacks.
- Default 48-hour result retention.
- Turnstile, rate-limit, anonymous usage, and abuse-control hooks.
- Deployment guide, subproject READMEs, security policy, contributing guide, roadmap, changelog, fixture provenance, screenshots, recording, and architecture diagram.

## Deployment Requirements

- Node.js 20+ and Yarn 1.x for the frontend and API Worker.
- Python 3.13 and `uv` for the Modal converter.
- Cloudflare Workers, D1, R2, Durable Objects, and Cron.
- Modal account with GPU access.
- Fresh D1/R2/Modal resources for the first public self-hosted install.

## Known Limits

- No compatibility migration is included for private pre-release production data.
- Hosted account management, billing, and paid plans are not part of this release.
- Broad office-document conversion beyond PDF/EPUB is out of scope.
- Real conversion quality depends on upstream `marker-pdf` behavior and the operator's Modal/GPU configuration.

## Before Publishing

- Replace placeholder security/conduct contacts.
- Run Gitleaks and final release scans.
- Delete private release-planning trackers.
- Verify hosted version, screenshots, and deployment smoke checks.
