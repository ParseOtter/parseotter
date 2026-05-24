# ParseOtter v0.1.3

Bugfix release for the Modal gateway dispatch crash.

The public hosted service is available for free at <https://www.parseotter.com/>.

## Highlights

- Fixed the "Modal dispatch failed: HTTP 500 Internal Server Error" bug affecting
  all PDF and EPUB conversion requests. The root cause was a type mismatch between
  Modal's server-side ASGI runtime (which passes scope headers as `bytearray`)
  and uvicorn's `ProxyHeadersMiddleware` (which expects `bytes`).

## Why This Release Exists

`v0.1.3` fixes a production regression introduced by a Modal infrastructure
update. The Modal service changed its internal ASGI header representation from
`bytes` to `bytearray`; since `bytearray` is unhashable in Python, the
`ProxyHeadersMiddleware` in the gateway's FastAPI app crashed on every request
with `TypeError: unhashable type: 'bytearray'`.

The middleware was removed — it was unnecessary in Modal's environment because
Modal handles proxy headers (X-Forwarded-For, X-Forwarded-Proto) internally.

## Verification

- CI passed on the release base commit.
- Security Scan passed on the release base commit.
- Modal gateway `/healthz` endpoint returns `{"status": "ok"}` after redeploy.
- Test PDF upload and conversion completes without dispatch failure.

## Notes For Operators

- Redeploy the Modal app after deploying this version:

  ```bash
  cd modal-converter
  MODAL_APP_NAME=parseotter-converter-production \
  CLOUDFLARE_DISPATCH_SECRET_NAME=parseotter-dispatch-secrets-production \
  uv run python -m modal deploy modal_app.py
  ```

- The fix is a removal of dead middleware — no configuration changes needed.
