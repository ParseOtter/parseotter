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
