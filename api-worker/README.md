# ParseOtter API Worker

Cloudflare Worker API for ParseOtter task orchestration, browser uploads, conversion dispatch, status polling, feedback, and downloads.

## Setup

```bash
yarn install
cp .dev.vars.example .dev.vars
yarn cf-typegen
```

Local development:

```bash
yarn dev --port 8787
```

Health check:

```bash
curl -sS http://127.0.0.1:8787/health
```

## Bindings

Configured in `wrangler.jsonc`:

- `DB`: D1 database for `parseotter_*` task, feedback, usage, and abuse tables.
- `R2_BUCKET`: stores `parseotter/{taskId}/input/...` and `parseotter/{taskId}/output/result.zip`.
- `TASK_COORDINATOR`: Durable Object namespace for per-task coordination.
- Cron: runs expired-task cleanup every 30 minutes.

Default example resources:

- development Worker: `parseotter-api`
- production Worker: `parseotter-api-production`
- development D1: `parseotter-tasks-dev`
- production D1: `parseotter-tasks-production`
- development R2: `parseotter-files-dev`
- production R2: `parseotter-files-production`

## Secrets

Required Worker secrets:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `MODAL_DISPATCH_API_KEY`
- `MODAL_CALLBACK_HMAC_SECRET`

Production may also require:

- `TURNSTILE_SECRET_KEY`
- `GA4_API_SECRET`

`MODAL_DISPATCH_API_KEY` must equal the Modal secret value named `API_SECRET`.
`MODAL_CALLBACK_HMAC_SECRET` must equal the Modal secret value named `MODAL_CALLBACK_HMAC_SECRET`.

## Runtime Vars

Important vars in `wrangler.jsonc`:

- `CORS_ORIGINS`: exact frontend origins allowed to call the API.
- `R2_BUCKET_NAME`, `R2_ACCOUNT_ID`, `R2_S3_ENDPOINT`: R2 signing target.
- `BACKEND_PUBLIC_ORIGIN`: public API origin used in Modal callback URLs.
- `MODAL_DISPATCH_URL`: Modal gateway dispatch endpoint.
- `TASK_RETENTION_HOURS`: default result/status retention window.
- `MAX_UPLOAD_FILE_SIZE_MB`: upload limit.
- `TURNSTILE_*`, `CLIENT_*`, `GLOBAL_*`: abuse controls.

## API Surface

- `GET /health`
- `POST /api/tasks`
- `POST /api/tasks/{taskId}/uploads`
- `POST /api/tasks/{taskId}/uploads/{uploadId}/parts/sign`
- `POST /api/tasks/{taskId}/uploads/{uploadId}/complete`
- `POST /api/tasks/{taskId}/uploads/{uploadId}/abort`
- `POST /api/internal/modal/callback`
- `GET /api/tasks/{taskId}`
- `GET /api/tasks/{taskId}/download`
- `POST /api/feedback`

The API returns common JSON success/error envelopes and includes request IDs in responses.

## Scripts

```bash
yarn cf-typegen
yarn typecheck
yarn test
yarn test:stage1
yarn test:stage2
yarn test:stage4
yarn dry-run:dev
yarn dry-run:production
yarn deploy:dev
yarn deploy:production
```

## R2 Policies

Apply CORS for browser presigned upload access:

```bash
npx wrangler r2 bucket cors set parseotter-files-dev --file infrastructure/r2-cors.dev.json
npx wrangler r2 bucket cors set parseotter-files-production --file infrastructure/r2-cors.production.json
```

Apply lifecycle cleanup for the `parseotter/` prefix:

```bash
npx wrangler r2 bucket lifecycle set parseotter-files-dev --file infrastructure/r2-lifecycle.parseotter.json
npx wrangler r2 bucket lifecycle set parseotter-files-production --file infrastructure/r2-lifecycle.parseotter.json
```

The Worker enforces task expiration as the access boundary. R2 lifecycle deletion is a fallback and can lag behind the 48-hour default retention window.
