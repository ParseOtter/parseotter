# Changelog

All notable changes to ParseOtter will be documented in this file.

## v0.1.0 - Unreleased

Initial open-source release preparation.

### Included

- React frontend for PDF/EPUB upload, local task history, Markdown preview, and ZIP download.
- Cloudflare Worker API for task orchestration, R2 multipart upload, status polling, feedback, and downloads.
- D1 schema for ParseOtter task state, usage, abuse counters, feedback, and retention metadata.
- Durable Object coordination for per-task workflows.
- Modal GPU converter using `marker-pdf`.
- HMAC-signed Modal callbacks.
- Synthetic test fixtures and public release assets.
- Self-hosting deployment documentation.

### Release Gate

- Run frontend, API Worker, and Modal converter tests.
- Run public-tree scans for secrets, obsolete names, generated files, and non-English public docs.
- Delete private release planning trackers before publishing the public repository.
