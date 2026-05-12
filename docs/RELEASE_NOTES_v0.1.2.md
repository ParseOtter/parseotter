# ParseOtter v0.1.2

Open-source release and deployment process maintenance.

The public hosted service is available for free at <https://www.parseotter.com/>.

## Highlights

- Clarified the self-hosted deployment guide so operators can distinguish the manual self-host path from ParseOtter's hosted production workflows.
- Fixed the frontend self-host deployment command so production Vite variables are included when the deployed Worker asset build is created.
- Added self-hosting guidance for Turnstile, GA4, Cloudflare Rate Limiting namespace IDs, and production acceptance checks.
- Removed hard-coded historical production resource names from public deployment workflows while keeping GitHub environment based deployment targeting.
- Fixed the issue template security contact link to point to ParseOtter's private vulnerability reporting URL.
- Automated release publishing so maintainers can create the annotated tag and GitHub Release from a manually confirmed workflow after CI and Security Scan pass.

## Why This Release Exists

`v0.1.2` keeps the public repository release archive aligned with the current self-hosting and maintenance workflow. It does not change the document conversion runtime behavior.

## Verification

- GitHub Actions CI passed on the release base commit.
- GitHub Security Scan passed on the release base commit.
- Hosted frontend production deployment passed after the production workflow cleanup.
- `www.parseotter.com` returned HTTP 200.
- `api.parseotter.com/health` returned `service: parseotter-api` and `runtime: cloudflare-worker`.
- Public deployment docs, issue templates, and production workflow files were checked after the maintenance updates.

## Notes For Operators

- Review `DEPLOYMENT.md` before using real Cloudflare or Modal resources.
- Set production frontend build variables on the final deploy command, not only on a separate build command.
- Replace all placeholder Cloudflare Rate Limiting namespace IDs before deploying a public production API Worker.
- If Turnstile or GA4 is disabled in your self-hosted production config, update both Worker vars and required secret declarations.
