# ParseOtter Frontend

React + Vite frontend for the ParseOtter PDF/EPUB-to-Markdown service.

For end-user use without self-hosting, the hosted service is free at <https://www.parseotter.com/>. This package is for local development and self-hosted deployments.

## Setup

```bash
yarn install
cp .env.example .env
```

For local development, `.env` normally points at the local API Worker:

```dotenv
VITE_PARSEOTTER_API_BASE_URL=http://localhost:8787
```

Optional production settings:

```dotenv
VITE_TURNSTILE_SITE_KEY=your-turnstile-site-key
VITE_GA4_MEASUREMENT_ID=G-XXXXXXXXXX
```

## Scripts

```bash
yarn dev
yarn typecheck
yarn test
yarn build
yarn preview
```

End-to-end tests use Playwright and the production preview server:

```bash
yarn build
yarn playwright test
```

## Deployment

The checked-in Worker names are:

- development: `parseotter-web`
- production: `parseotter-web-production`

Build with the API origin that the browser should call:

```bash
VITE_PARSEOTTER_API_BASE_URL=https://api.yourdomain.com yarn build
yarn deploy --env production
```

The API Worker must allow the final frontend origin in `CORS_ORIGINS`, and the R2 CORS policy must also allow that exact origin for browser multipart uploads.

## Troubleshooting

- Empty API URL warnings mean `VITE_PARSEOTTER_API_BASE_URL` is missing for a non-local build.
- Upload failures after signing often mean R2 CORS is missing `PUT` or exposed `ETag`.
- Turnstile errors usually mean the site key, secret key, or expected hostname does not match the deployed domain.
