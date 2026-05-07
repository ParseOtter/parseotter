# ParseOtter Modal Converter

Python 3.13 Modal backend for ParseOtter GPU document conversion. It downloads inputs from Cloudflare R2, runs `marker-pdf`, writes ZIP results, and sends signed callbacks to the API Worker.

## Setup

```bash
uv sync
uv run pytest
```

Modal CLI authentication:

```bash
uv run modal profile current
uv run modal token new
```

## Configuration

Important environment variables:

- `MODAL_APP_NAME`: `parseotter-converter-dev` or `parseotter-converter-production`.
- `CLOUDFLARE_DISPATCH_SECRET_NAME`: `parseotter-dispatch-secrets-dev` or `parseotter-dispatch-secrets-production`.
- `MODAL_MODELS_VOLUME_NAME`: default `parseotter-models`.
- `MODAL_CACHE_VOLUME_NAME`: `parseotter-cache-dev` or `parseotter-cache-production`.
- `GPU_TYPE`: Modal GPU type, default `L40S`.
- `MARKER_SERVICE_MIN_CONTAINERS`, `MARKER_SERVICE_MAX_CONTAINERS`: warm pool and fanout controls.

The Modal secret must include:

- `API_SECRET`: must equal the Worker `MODAL_DISPATCH_API_KEY`.
- `MODAL_CALLBACK_HMAC_SECRET`: must equal the Worker `MODAL_CALLBACK_HMAC_SECRET`.
- `CLOUDFLARE_R2_ACCOUNT_ID`
- `CLOUDFLARE_R2_BUCKET_NAME`
- `CLOUDFLARE_R2_ENDPOINT_URL`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`

Use the root `.cloudflare-dispatch-secrets.env.example` and [DEPLOYMENT.md](../DEPLOYMENT.md) as the canonical deployment reference.

## Deploy

Production example:

```bash
MODAL_APP_NAME=parseotter-converter-production \
GPU_TYPE=H100 \
MODAL_MODELS_VOLUME_NAME=parseotter-models \
MODAL_CACHE_VOLUME_NAME=parseotter-cache-production \
CLOUDFLARE_DISPATCH_SECRET_NAME=parseotter-dispatch-secrets-production \
uv run python -m modal deploy modal_app.py
```

Development example:

```bash
MODAL_APP_NAME=parseotter-converter-dev \
GPU_TYPE=L40S \
MODAL_MODELS_VOLUME_NAME=parseotter-models \
MODAL_CACHE_VOLUME_NAME=parseotter-cache-dev \
CLOUDFLARE_DISPATCH_SECRET_NAME=parseotter-dispatch-secrets-dev \
uv run python -m modal deploy modal_app.py
```

Copy the deployed `gateway_app` URL into the API Worker `MODAL_DISPATCH_URL` with the path `/api/internal/cloudflare/jobs/dispatch`.

## Local Utilities

Run a local staged conversion wrapper:

```bash
uv run python -m modal run modal_app.py::invoke_conversion --pdf-file /path/to/file.pdf
```

Run a smoke inference helper:

```bash
uv run python -m modal run modal_app.py::smoke_run_marker_inference --pdf-file /path/to/file.pdf
```

## Troubleshooting

- `401` from Modal dispatch usually means Worker `MODAL_DISPATCH_API_KEY` does not match Modal `API_SECRET`.
- Worker callback signature failures usually mean `MODAL_CALLBACK_HMAC_SECRET` differs between Worker and Modal.
- R2 download/upload errors usually mean the Modal R2 secret points at the wrong bucket, endpoint, or credentials.
- GPU OOM or timeout failures should be handled by changing `GPU_TYPE`, upload limits, or Modal timeout/fanout settings.
