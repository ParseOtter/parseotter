# ParseOtter Roadmap

This roadmap describes likely product directions after the initial open source
release. It is not a commitment to ship every item, and priorities may change
based on deployment feedback, conversion quality issues, cost, and maintainer
bandwidth.

## Current Release Scope

The initial public release focuses on making the existing service clean,
self-hostable, and understandable:

- Browser upload for PDF and EPUB files.
- Direct multipart upload to Cloudflare R2.
- Cloudflare Worker API for task creation, upload orchestration, status polling,
  feedback, and downloads.
- D1-backed task state, abuse counters, feedback storage, and retention metadata.
- Durable Object coordination for per-task workflows.
- Modal GPU conversion powered by marker.
- Markdown preview in the browser.
- ZIP download containing Markdown and extracted assets.
- Default 48-hour result retention.
- Turnstile support, rate limiting, anonymous abuse controls, and HMAC-signed
  Modal callbacks.

## Product Principles

- Keep ParseOtter focused on document-to-Markdown conversion.
- Prefer deployable, observable workflows over hidden magic.
- Keep self-hosting practical for small teams.
- Avoid default features that unexpectedly increase GPU or LLM cost.
- Document operational limits clearly before adding more surface area.
- Treat upstream marker behavior and terms as important external dependencies.

## Phase 1: Release Hardening

Goal: make the first public release easier to deploy and safer to operate.

Planned work:

- Improve deployment documentation based on fresh-install feedback.
- Add CI for frontend, API Worker, and Modal converter tests.
- Add synthetic PDF and EPUB fixtures with documented provenance.
- Improve release audit scripts for secrets, generated files, old naming, and
  non-English public docs.
- Add clearer privacy and retention documentation.
- Add screenshots, a short recording, and an architecture diagram.
- Tighten configuration validation around Worker, R2, D1, Modal, Turnstile, and
  analytics settings.

Success criteria:

- A new self-hoster can deploy the stack from the public docs without private
  context.
- Generated files and local secrets stay out of the repository.
- Public docs explain what data is stored, where it is stored, and when it
  expires.

## Phase 2: Conversion Controls

Goal: expose useful conversion options without making the public API unstable.

Candidate work:

- Add user-facing page range selection.
- Add opt-in OCR controls where supported by the conversion pipeline.
- Add image output format selection where it is reliable.
- Add clearer cache behavior and, if needed, an explicit reprocess option.
- Add task option persistence only after the API and D1 state model are designed
  for it.
- Add result quality checks for common document layouts.

Success criteria:

- Users can reduce conversion time for large documents by selecting relevant
  pages.
- Conversion options are reflected consistently in frontend state, API payloads,
  D1 records, Modal processing, and downloaded results.
- Existing default behavior remains simple.

## Phase 3: API And Batch Workflows

Goal: make ParseOtter easier to integrate into document ingestion pipelines.

Candidate work:

- Add a documented public API surface for task creation, status, and result
  retrieval.
- Add API key support for self-hosted deployments.
- Add batch upload and batch result workflows.
- Add webhook callbacks for completed or failed tasks.
- Add stronger quota controls for public hosted instances.
- Add structured examples for RAG ingestion workflows.

Success criteria:

- Developers can integrate ParseOtter without depending on browser-only flows.
- Batch workflows have clear concurrency, quota, retry, and failure semantics.
- Public API security expectations are documented.

## Phase 4: Output Quality And Formats

Goal: improve output usefulness while keeping cost and complexity explicit.

Candidate work:

- Improve table handling where practical.
- Explore structured JSON output for downstream chunking and retrieval.
- Explore HTML output when it preserves document structure better than Markdown.
- Add optional post-processing steps that can be enabled by self-hosters.
- Evaluate LLM-assisted cleanup as an opt-in feature, not a default.

Success criteria:

- Format additions are covered by fixtures and regression tests.
- Users can understand cost and quality tradeoffs before enabling optional
  enhancements.
- Markdown remains the default output.

## Phase 5: Operations And Administration

Goal: help operators understand and manage a running ParseOtter instance.

Candidate work:

- Add an operator view for recent tasks, failures, queue pressure, and cleanup.
- Add clearer metrics for conversion success rate, latency, and cost.
- Add retention controls for self-hosted deployments.
- Add stronger audit logging for administrative actions.
- Add optional Cloudflare Access guidance for private deployments.

Success criteria:

- Operators can diagnose common failures without reading raw logs first.
- Public deployments can tune limits without code changes.
- Private deployments can document access control and retention choices.

## Not Planned For The Initial Release

- Paid plans, billing, or hosted account management.
- Compatibility migrations for private pre-release production data.
- Broad office-document conversion beyond the focused PDF/EPUB release scope.
- A general RAG platform or chat application.
- Claims about matching any commercial service on every document type.

## Feedback

The most useful feedback is specific and reproducible:

- Deployment steps that were unclear or wrong.
- Safe-to-share documents where conversion quality is poor.
- Error messages that did not explain the real problem.
- Self-hosting limits that required code changes instead of configuration.
