# ParseOtter Deployment Guide

You do not need this guide to use ParseOtter. The public hosted service is free at <https://www.parseotter.com/>; use this guide only when deploying your own instance.

This guide walks through a fresh self-hosted ParseOtter deployment:

- `frontend`: React + Vite app deployed as Cloudflare Worker static assets.
- `api-worker`: Hono API deployed to Cloudflare Workers with D1, R2, Durable Objects, Cron, and Worker secrets.
- `modal-converter`: Python 3.13 Modal app that runs GPU conversion and sends signed callbacks to the API Worker.

Use fresh D1, R2, Worker, and Modal resources for a first public install. Reusing private pre-release data requires a separate migration plan.

## Architecture

```text
Browser
  |
  | loads UI, uploads file parts, polls task status
  v
frontend
  https://www.yourdomain.com
  |
  | REST API calls
  v
api-worker
  https://api.yourdomain.com
  |
  | signed dispatch request
  v
modal-converter
  https://your-workspace--parseotter-converter-production-gateway-app.modal.run
```

Storage:

- D1 stores task state, feedback, abuse counters, usage counters, and migration history.
- R2 stores uploaded source files and conversion result ZIPs under `parseotter/{taskId}/...`.
- Modal Volumes store model and cache data used by GPU workers.

## Requirements

Local tools:

- Node.js 20+
- Yarn 1.x
- Python 3.13
- `uv`
- Wrangler through this repository's Node dependencies
- Modal CLI through the Modal converter environment

Accounts:

- Cloudflare account with Workers, D1, R2, and Durable Objects enabled
- Modal account with GPU access

Optional services:

- Cloudflare Turnstile for bot protection
- Google Analytics 4 for usage events
- Custom domains such as `www.yourdomain.com` and `api.yourdomain.com`

## Resource Names

Replace placeholders with names from your own infrastructure. The checked-in examples use:

| Resource | Example |
| --- | --- |
| Frontend Worker | `parseotter-web` |
| Frontend Worker production | `parseotter-web-production` |
| API Worker | `parseotter-api` |
| API Worker production | `parseotter-api-production` |
| D1 development database | `parseotter-tasks-dev` |
| D1 production database | `parseotter-tasks-production` |
| R2 development bucket | `parseotter-files-dev` |
| R2 production bucket | `parseotter-files-production` |
| Modal development app | `parseotter-converter-dev` |
| Modal production app | `parseotter-converter-production` |
| Modal models volume | `parseotter-models` |
| Modal development cache volume | `parseotter-cache-dev` |
| Modal production cache volume | `parseotter-cache-production` |
| Modal development secret | `parseotter-dispatch-secrets-dev` |
| Modal production secret | `parseotter-dispatch-secrets-production` |

Checked-in routes use `api.example.com`, `www.example.com`, `yourdomain.com`, and `your-*.workers.dev` placeholders. Do not commit real account IDs, domains, API keys, or secrets.

## Deployment Order

1. Verify local tools and account login.
2. Create Cloudflare D1 databases and R2 buckets.
3. Update Worker configuration placeholders.
4. Apply D1 migrations.
5. Apply R2 CORS and lifecycle policies.
6. Set Worker secrets.
7. Create Modal secrets.
8. Deploy Modal.
9. Deploy the API Worker.
10. Build and deploy the frontend Worker.
11. Run acceptance checks.

Deploy Modal before the API Worker whenever the Modal gateway URL changes. Deploy the API Worker before the frontend whenever the frontend build needs a new API origin.

## 1. Verify Tools

```bash
cd api-worker
yarn install
yarn wrangler whoami
yarn wrangler --version
```

```bash
cd ../frontend
yarn install
yarn typecheck
yarn test
yarn build
```

```bash
cd ../modal-converter
uv sync
uv run modal profile current
uv run pytest
```

If `wrangler whoami` shows multiple Cloudflare accounts, set `account_id` in both `wrangler.jsonc` files or export the account explicitly when running commands.

## 2. Create Cloudflare Resources

D1:

```bash
cd api-worker
yarn wrangler d1 create parseotter-tasks-dev
yarn wrangler d1 create parseotter-tasks-production
```

Copy the returned IDs into:

- `api-worker/wrangler.jsonc` top-level `d1_databases[0].database_id`
- `api-worker/wrangler.jsonc` `env.production.d1_databases[0].database_id`

R2:

```bash
yarn wrangler r2 bucket create parseotter-files-dev
yarn wrangler r2 bucket create parseotter-files-production
```

In `api-worker/wrangler.jsonc`, replace:

- `YOUR_CLOUDFLARE_ACCOUNT_ID`
- `YOUR_D1_DATABASE_ID`
- `YOUR_PRODUCTION_D1_DATABASE_ID`
- `https://your-cloudflare-account-id.r2.cloudflarestorage.com`

The R2 S3 endpoint format is:

```text
https://<cloudflare-account-id>.r2.cloudflarestorage.com
```

Also set `account_id` in `frontend/wrangler.jsonc` if you deploy from an account with multiple Cloudflare accounts available.

## 3. Configure Domains

For production custom domains, configure:

- API route: `api.yourdomain.com`
- Frontend route: `www.yourdomain.com`
- API production `CORS_ORIGINS`: `https://www.yourdomain.com`
- API production `BACKEND_PUBLIC_ORIGIN`: `https://api.yourdomain.com`
- API production `TURNSTILE_EXPECTED_HOSTNAMES`: `www.yourdomain.com`
- Frontend build `VITE_PARSEOTTER_API_BASE_URL`: `https://api.yourdomain.com`

For an initial smoke test, you can deploy to `workers.dev`. Use the exact final frontend origin in API `CORS_ORIGINS` and R2 CORS. Worker names differ by environment, so `parseotter-web.workers.dev` and `parseotter-web-production.workers.dev` are different origins.

## 4. Apply D1 Migrations

```bash
cd api-worker
yarn wrangler d1 migrations apply parseotter-tasks-dev --remote
yarn wrangler d1 migrations apply parseotter-tasks-production --remote --env production
```

Inspect migration history:

```bash
yarn wrangler d1 execute parseotter-tasks-production --remote --env production \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
```

## 5. Apply R2 Policies

Update `api-worker/infrastructure/r2-cors.dev.json` and `api-worker/infrastructure/r2-cors.production.json` so allowed origins match your deployed frontend origins.

Apply CORS:

```bash
cd api-worker
yarn wrangler r2 bucket cors set parseotter-files-dev --file infrastructure/r2-cors.dev.json
yarn wrangler r2 bucket cors set parseotter-files-production --file infrastructure/r2-cors.production.json
yarn wrangler r2 bucket cors list parseotter-files-production
```

Multipart browser upload requires `GET`, `HEAD`, `PUT`, and exposed `ETag`.

Apply lifecycle fallback:

```bash
yarn wrangler r2 bucket lifecycle set parseotter-files-dev --file infrastructure/r2-lifecycle.parseotter.json
yarn wrangler r2 bucket lifecycle set parseotter-files-production --file infrastructure/r2-lifecycle.parseotter.json
```

The Worker enforces result access expiration. R2 lifecycle deletion is a fallback and can lag behind task expiration.

## 6. Set Worker Secrets

Development:

```bash
cd api-worker
printf '%s' "$R2_ACCESS_KEY_ID" | yarn wrangler secret put R2_ACCESS_KEY_ID
printf '%s' "$R2_SECRET_ACCESS_KEY" | yarn wrangler secret put R2_SECRET_ACCESS_KEY
printf '%s' "$MODAL_DISPATCH_API_KEY" | yarn wrangler secret put MODAL_DISPATCH_API_KEY
printf '%s' "$MODAL_CALLBACK_HMAC_SECRET" | yarn wrangler secret put MODAL_CALLBACK_HMAC_SECRET
```

Production:

```bash
printf '%s' "$R2_ACCESS_KEY_ID" | yarn wrangler secret put R2_ACCESS_KEY_ID --env production
printf '%s' "$R2_SECRET_ACCESS_KEY" | yarn wrangler secret put R2_SECRET_ACCESS_KEY --env production
printf '%s' "$MODAL_DISPATCH_API_KEY" | yarn wrangler secret put MODAL_DISPATCH_API_KEY --env production
printf '%s' "$MODAL_CALLBACK_HMAC_SECRET" | yarn wrangler secret put MODAL_CALLBACK_HMAC_SECRET --env production
```

Optional production secrets:

```bash
printf '%s' "$TURNSTILE_SECRET_KEY" | yarn wrangler secret put TURNSTILE_SECRET_KEY --env production
printf '%s' "$GA4_API_SECRET" | yarn wrangler secret put GA4_API_SECRET --env production
```

The Worker `MODAL_DISPATCH_API_KEY` must equal Modal `API_SECRET`.
The Worker `MODAL_CALLBACK_HMAC_SECRET` must equal Modal `MODAL_CALLBACK_HMAC_SECRET`.

## 7. Create Modal Secrets

Create a temporary development JSON file:

```json
{
  "API_SECRET": "<same-as-worker-MODAL_DISPATCH_API_KEY>",
  "MODAL_CALLBACK_HMAC_SECRET": "<same-as-worker-MODAL_CALLBACK_HMAC_SECRET>",
  "CLOUDFLARE_R2_ACCOUNT_ID": "your-cloudflare-account-id",
  "CLOUDFLARE_R2_BUCKET_NAME": "parseotter-files-dev",
  "CLOUDFLARE_R2_ENDPOINT_URL": "https://your-cloudflare-account-id.r2.cloudflarestorage.com",
  "CLOUDFLARE_R2_ACCESS_KEY_ID": "<r2-access-key-id>",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY": "<r2-secret-access-key>",
  "R2_IO_TIMEOUT_SECONDS": "300",
  "MODAL_CALLBACK_TIMEOUT_SECONDS": "10",
  "MODAL_CALLBACK_MAX_ATTEMPTS": "3",
  "MODAL_CALLBACK_RETRY_BASE_DELAY_SECONDS": "1"
}
```

Create another file for production and change only the bucket name to `parseotter-files-production`.

Upload both secrets:

```bash
cd modal-converter
uv run modal secret create parseotter-dispatch-secrets-dev --force --from-json /tmp/parseotter-dispatch-secrets.dev.json
uv run modal secret create parseotter-dispatch-secrets-production --force --from-json /tmp/parseotter-dispatch-secrets.production.json
```

Remove the temporary JSON files after upload.

## 8. Deploy Modal

Production:

```bash
cd modal-converter
MODAL_APP_NAME=parseotter-converter-production \
GPU_TYPE=H100 \
MODAL_MODELS_VOLUME_NAME=parseotter-models \
MODAL_CACHE_VOLUME_NAME=parseotter-cache-production \
MARKER_PDFTEXT_WORKERS=4 \
MARKER_SERVICE_MIN_CONTAINERS=0 \
MARKER_SERVICE_MAX_CONTAINERS=5 \
CLOUDFLARE_DISPATCH_SECRET_NAME=parseotter-dispatch-secrets-production \
uv run python -m modal deploy modal_app.py
```

Development:

```bash
MODAL_APP_NAME=parseotter-converter-dev \
GPU_TYPE=L40S \
MODAL_MODELS_VOLUME_NAME=parseotter-models \
MODAL_CACHE_VOLUME_NAME=parseotter-cache-dev \
CLOUDFLARE_DISPATCH_SECRET_NAME=parseotter-dispatch-secrets-dev \
uv run python -m modal deploy modal_app.py
```

Copy the deployed `gateway_app` URL and set API Worker `MODAL_DISPATCH_URL` to:

```text
https://your-workspace--parseotter-converter-production-gateway-app.modal.run/api/internal/cloudflare/jobs/dispatch
```

Check Modal health:

```bash
curl -sS -i https://your-workspace--parseotter-converter-production-gateway-app.modal.run/healthz
```

## 9. Deploy API Worker

Before deploying, update production vars in `api-worker/wrangler.jsonc`:

```jsonc
"CORS_ORIGINS": "https://www.yourdomain.com",
"R2_ACCOUNT_ID": "your-cloudflare-account-id",
"R2_BUCKET_NAME": "parseotter-files-production",
"R2_S3_ENDPOINT": "https://your-cloudflare-account-id.r2.cloudflarestorage.com",
"BACKEND_PUBLIC_ORIGIN": "https://api.yourdomain.com",
"MODAL_DISPATCH_URL": "https://your-workspace--parseotter-converter-production-gateway-app.modal.run/api/internal/cloudflare/jobs/dispatch",
"TURNSTILE_EXPECTED_HOSTNAMES": "www.yourdomain.com"
```

Deploy:

```bash
cd api-worker
yarn cf-typegen
yarn typecheck
yarn test
yarn dry-run:production
yarn deploy:production
```

Health check:

```bash
curl -sS -i https://api.yourdomain.com/health
```

Expected response includes:

- `success: true`
- `status: ok`
- `service: parseotter-api`
- `runtime: cloudflare-worker`

## 10. Deploy Frontend

Build with the production API origin:

```bash
cd frontend
yarn typecheck
yarn test
VITE_PARSEOTTER_API_BASE_URL=https://api.yourdomain.com yarn build
yarn deploy --env production
```

Check the frontend:

```bash
curl -sS -i https://www.yourdomain.com/
```

## 11. Acceptance Checks

Run these checks after production deploy:

```bash
curl -sS -i https://api.yourdomain.com/health
curl -sS -i https://www.yourdomain.com/
curl -sS -i https://your-workspace--parseotter-converter-production-gateway-app.modal.run/healthz
```

Create a task:

```bash
curl -sS -i \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.yourdomain.com' \
  https://api.yourdomain.com/api/tasks \
  --data '{"fileName":"synthetic.pdf","fileType":"application/pdf","fileSizeBytes":1024}'
```

Inspect recent tasks:

```bash
cd api-worker
yarn wrangler d1 execute parseotter-tasks-production --remote --env production \
  --command "SELECT task_id, file_name, input_object_key, status, error_code, error_message, created_at, updated_at FROM parseotter_tasks ORDER BY created_at DESC LIMIT 5"
```

End-to-end browser check:

1. Open `https://www.yourdomain.com/`.
2. Upload a synthetic PDF or EPUB you are allowed to process.
3. Confirm upload reaches R2 under `parseotter/{taskId}/input/...`.
4. Confirm Modal receives the dispatch.
5. Confirm API callback succeeds.
6. Confirm status becomes complete.
7. Confirm Markdown preview opens.
8. Confirm ZIP download works.

## Troubleshooting

### Browser Upload Fails After Signing

Check R2 CORS. The final frontend origin must be allowed, `PUT` must be allowed, and `ETag` must be exposed.

### Modal Dispatch Returns 401

Worker `MODAL_DISPATCH_API_KEY` does not match Modal `API_SECRET`, or the Modal secret was uploaded to the wrong Modal environment.

### Modal Callback Signature Fails

Worker `MODAL_CALLBACK_HMAC_SECRET` does not match Modal `MODAL_CALLBACK_HMAC_SECRET`, or the callback timestamp is outside `MODAL_CALLBACK_TOLERANCE_SECONDS`.

### D1 Migration Fails

Do not apply this repository's initial migration over an older private database. Create a fresh D1 database or write a dedicated migration from the old schema.

### Frontend Calls The Wrong API

Rebuild the frontend with the correct `VITE_PARSEOTTER_API_BASE_URL`. Vite embeds this value at build time.

### Turnstile Rejects Uploads

Check that `VITE_TURNSTILE_SITE_KEY`, Worker `TURNSTILE_SECRET_KEY`, and `TURNSTILE_EXPECTED_HOSTNAMES` all refer to the same deployed frontend hostname.
