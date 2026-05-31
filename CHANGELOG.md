# Changelog

All notable changes to ParseOtter will be documented in this file.

## v0.2.0 - 2026-05-31

### Added

- MCP (Model Context Protocol) server for AI agent integration (`mcp-server/`).
  Users can now convert PDF/EPUB documents to Markdown directly from AI agents
  like Claude Desktop, Claude Code, Cursor, and VS Code.

- Three MCP tools:
  - `convert_document`: Upload and convert documents with a single tool call
  - `check_conversion_status`: Monitor long-running conversions
  - `get_conversion_result`: Download completed conversion results

- High-quality document conversion using marker-pdf ML models.

- Image extraction from converted documents.

- OCR support for scanned documents.

- Page range selection for converting specific pages.

- Progress reporting via MCP logging notifications.

- Automatic retry with exponential backoff for rate limits and transient errors.

- Flexible configuration via environment variables:
  - `PARSEOTTER_API_KEY`: API key for authentication
  - `PARSEOTTER_API_BASE_URL`: Custom API endpoint
  - `PARSEOTTER_TIMEOUT_MS`: Conversion timeout
  - `PARSEOTTER_MAX_RETRIES`: Maximum retry attempts
  - `PARSEOTTER_RETRY_DELAY_MS`: Base delay between retries

### Documentation

- Comprehensive MCP server documentation in `mcp-server/README.md`.
- Configuration examples for Claude Desktop, Claude Code, Cursor, and VS Code.
- Troubleshooting guide for common errors.

## v0.1.4 - 2026-05-31

### Added

- API key authentication for local applications (CLI, desktop apps, scripts).
  API keys allow calling the ParseOtter API without browser-based Turnstile
  verification while still enforcing abuse limits and rate limiting.

- New `parseotter_api_keys` D1 table for storing hashed API keys.

- API key management script (`api-worker/scripts/api-key.mjs`) for generating,
  listing, and revoking keys.

- D1 migration step in the API production deploy workflow, ensuring schema
  changes are applied before Worker deployment.

- Gitleaks allowlist configuration (`.gitleaks.toml`) for test fixtures.

### Release Verification

- GitHub Actions CI passed on the release base commit.
- GitHub Security Scan passed on the release base commit.
- API key authentication was verified end-to-end against production: task creation, file upload, Modal conversion, and result download all succeeded with a valid API key.

## v0.1.3 - 2026-05-24

### Fixed

- Removed `ProxyHeadersMiddleware` from the Modal gateway FastAPI app, which was
  incompatible with Modal's server-side ASGI runtime. Modal recently changed its
  ASGI scope header format from `bytes` to `bytearray`; since `bytearray` is
  unhashable, `dict(scope["headers"])` raised `TypeError`, causing a bare
  HTTP 500 on every dispatch request. The middleware was unnecessary in Modal's
  environment — Modal handles proxy headers internally.

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
