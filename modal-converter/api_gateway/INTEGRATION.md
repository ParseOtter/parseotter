# Integration Notes — Module A (API Gateway)

This document explains how to integrate the `api_gateway` router into the existing Modal FastAPI app (`modal_app.py`) without changing the internal Orchestrator/Marker implementation (treated as black-box).

1) Environment variables

- `MARKER_JOB_DIR` (default `/cache/marker-jobs`) — Volume path where jobs are written. Must be mounted into the Modal app and any GPU/worker containers that process jobs.
- `MAX_UPLOAD_BYTES` (default `157286400`) — Maximum accepted upload size in bytes (150MB default).
- `CORS_ORIGINS` (default `*`) — Comma-separated origins allowed for CORS.
- `API_SECRET` (optional) — If set, the dispatch, status, and download routes require `X-API-KEY` to match.

2) Volume requirements

Ensure the Modal deployment mounts a shared volume at the path specified by `MARKER_JOB_DIR` for:
- the API gateway (this router)
- the Orchestrator / Marker GPU containers

Example with Modal Volumes already declared in `modal_app.py`:

```py
# inside modal_app.py (class or app setup)
from api_gateway import handlers as api_handlers

app = FastAPI()
app.include_router(api_handlers.router, prefix="/api")
```

If `gateway_app()` creates the `FastAPI` instance, call `app.include_router(...)` on that instance before returning it.

3) Minimal registration snippet

Locate where the existing FastAPI app is created in `modal_app.py` (inside `gateway_app()`), then add the router inclusion:

```py
from api_gateway import handlers as api_handlers

def gateway_app():
    app = FastAPI()
    # existing middleware and routes...
    app.include_router(api_handlers.router, prefix="/api")
    return app
```

Notes:
- Use the package import path appropriate to your project layout; tests in this repo load modules by file path for isolation.
- Do not modify or access `jobs_dict` or internal Modal objects; the gateway writes files/status/enqueue and relies on the Orchestrator to discover them.

4) Deployment checklist

- Ensure `models_volume`/`cache_volume` and the `MARKER_JOB_DIR` volume are present and mounted into the API container and any worker containers.
- Confirm `MARKER_JOB_DIR` path matches the existing Modal service configuration (the gateway defaults to `/cache/marker-jobs`).
- Set `API_SECRET` only if you plan to require an API key for internal dispatch and job artifact access.

5) Local testing

Use `pytest` to run the `modal-converter/api_gateway/tests` suite. The tests exercise file writes in a temporary directory and do not require Modal to be running.

6) Runtime considerations

- The router exposes the ParseOtter internal dispatch surface: `POST /api/internal/cloudflare/jobs/dispatch`, `GET /api/jobs/{job_id}`, and `GET /api/jobs/{job_id}/download`.
- Dispatch requests must include a non-empty `X-Idempotency-Key` header and a payload that passes `cloudflare_dispatch.validate_dispatch_payload()`.
