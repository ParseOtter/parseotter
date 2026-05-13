# ParseOtter

[![CI](https://github.com/ParseOtter/parseotter/actions/workflows/ci.yml/badge.svg)](https://github.com/ParseOtter/parseotter/actions/workflows/ci.yml)
[![Security Scan](https://github.com/ParseOtter/parseotter/actions/workflows/security.yml/badge.svg)](https://github.com/ParseOtter/parseotter/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/ParseOtter/parseotter?sort=semver)](https://github.com/ParseOtter/parseotter/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/github/license/ParseOtter/parseotter)](LICENSE)

Use ParseOtter for free at <https://www.parseotter.com/>.

ParseOtter is a free-to-use PDF/EPUB-to-Markdown conversion service and an open-source, self-hostable implementation powered by Cloudflare Workers, R2, D1, Durable Objects, Modal GPU inference, and `marker-pdf`.

[Try the hosted service](https://www.parseotter.com/) · [Self-hosting guide](DEPLOYMENT.md) · [Architecture](#architecture) · [Latest release notes](docs/RELEASE_NOTES_v0.1.2.md)

![ParseOtter upload screen](docs/assets/parseotter-upload-screen.png)

## Use It Free

The public hosted service is available at <https://www.parseotter.com/>. You can convert PDF and EPUB files to Markdown there without deploying this repository.

Use the repository when you want to run your own instance, inspect the architecture, or contribute changes.

## Why ParseOtter?

ParseOtter is not just a converter wrapper. It is a complete, inspectable async document conversion service:

- Browser uploads go directly to Cloudflare R2 through multipart upload sessions.
- The API Worker owns task creation, status polling, download links, feedback, quotas, and retention metadata.
- Durable Objects coordinate per-task state.
- Modal GPU jobs run `marker-pdf` conversion and call the Worker back with HMAC-signed results.
- Users get Markdown preview in the browser and a ZIP download containing Markdown plus extracted assets.

That makes ParseOtter useful when private documents, repeatable deployments, auditability, or AI/RAG ingestion workflows matter more than a one-off hosted upload form.

## Who Is This For?

- AI and RAG developers who need Markdown plus extracted assets from PDF or EPUB sources.
- Documentation and knowledge-base teams preparing documents for search, ingestion, or review.
- Self-hosters who want an auditable document conversion pipeline.
- Operators who need explicit storage, retention, rate limiting, and callback behavior.
- Contributors who want a production-style Cloudflare Workers and Modal example to inspect or extend.

## What It Includes

- Browser upload UI for PDF and EPUB files.
- Direct multipart uploads from the browser to Cloudflare R2.
- Cloudflare Worker API for task creation, upload orchestration, polling, feedback, and downloads.
- D1 task state, feedback, abuse counters, and retention metadata.
- Durable Object coordination per conversion task.
- Modal GPU conversion backend using `marker-pdf`.
- Markdown preview and ZIP download with extracted assets.
- Default 48-hour result retention.
- Turnstile, rate limiting, anonymous usage controls, and HMAC-signed Modal callbacks.

## Known Limitations

- Conversion quality depends on upstream `marker-pdf` behavior and the source document layout.
- Complex tables, scanned documents, math-heavy PDFs, multi-column papers, and unusual encodings may need manual review or future conversion controls.
- The hosted service is designed for interactive conversion, not unlimited batch ingestion.
- Self-hosted deployments require Cloudflare and Modal resources; a one-command local-only deployment is not included yet.
- Result retention is intentionally short by default. Operators should adjust retention, privacy notices, and access controls for their own environment.

## Architecture

![ParseOtter architecture](docs/assets/architecture.svg)

The stack has three deployable parts:

- `frontend`: React + Vite app deployed as a Cloudflare Worker static asset app.
- `api-worker`: Hono API deployed to Cloudflare Workers with D1, R2, Durable Objects, Cron, and Worker secrets.
- `modal-converter`: Python 3.13 Modal app that runs GPU conversion jobs and calls the Worker back with signed results.

## Self-Hosting Quick Start

Install local dependencies:

```bash
cd frontend
yarn install

cd ../api-worker
yarn install

cd ../modal-converter
uv sync
```

Run local checks:

```bash
cd frontend
yarn typecheck
yarn test
yarn build

cd ../api-worker
yarn cf-typegen
yarn typecheck
yarn test

cd ../modal-converter
uv run pytest
```

For a full self-hosted deployment, start with [DEPLOYMENT.md](DEPLOYMENT.md). Use fresh D1/R2/Modal resources for a first public install.

## Self-Hosting Configuration

Public example names use ParseOtter placeholders:

- Frontend Worker: `parseotter-web`, `parseotter-web-production`
- API Worker: `parseotter-api`, `parseotter-api-production`
- D1: `parseotter-tasks-dev`, `parseotter-tasks-production`
- R2: `parseotter-files-dev`, `parseotter-files-production`
- Modal app: `parseotter-converter-dev`, `parseotter-converter-production`

Checked-in routes use `example.com`, `yourdomain.com`, and `your-*.workers.dev` placeholders. Replace every account ID, database ID, bucket name, endpoint, domain, and secret before deploying.

## Privacy And Retention

In the default deployment model:

- Uploaded source files and result ZIPs are stored in Cloudflare R2.
- Task metadata, feedback, usage counters, and retention timestamps are stored in Cloudflare D1.
- Result access expires after 48 hours by default.
- A Worker Cron cleanup marks expired tasks and deletes recorded R2 input/output objects.
- Browser local history is stored only in the user's browser local storage.

Self-hosters are responsible for their own privacy policy, user notices, Cloudflare/Modal configuration, data retention settings, logs, access controls, and abuse handling.

## Documentation

- [Deployment guide](DEPLOYMENT.md)
- [Public conversion examples](docs/examples/README.md)
- [Frontend README](frontend/README.md)
- [API Worker README](api-worker/README.md)
- [Modal Converter README](modal-converter/README.md)
- [Public assets](docs/assets/README.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [Fixture provenance](docs/FIXTURES.md)
- [v0.1.2 release notes](docs/RELEASE_NOTES_v0.1.2.md)
- [v0.1.1 release notes](docs/RELEASE_NOTES_v0.1.1.md)
- [v0.1.0 release notes](docs/RELEASE_NOTES_v0.1.0.md)

## Acknowledgements

ParseOtter builds on:

- [Cloudflare Workers](https://developers.cloudflare.com/workers/), [R2](https://developers.cloudflare.com/r2/), [D1](https://developers.cloudflare.com/d1/), and [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Modal](https://modal.com/)
- [`marker-pdf`](https://github.com/datalab-to/marker)

## License

AGPL-3.0. See [LICENSE](LICENSE).
