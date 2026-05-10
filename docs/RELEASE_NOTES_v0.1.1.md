# ParseOtter v0.1.1

Public release surface refresh for the initial open-source release.

The public hosted service is available for free at <https://www.parseotter.com/>.

## Highlights

- Polished the top-level README and deployment guide to make the hosted service, self-hosting path, architecture, and privacy/retention model clearer.
- Updated frontend, API Worker, and Modal converter READMEs with consistent hosted-service and self-hosting language.
- Refreshed ParseOtter branding assets, app icons, favicon, upload screenshot, and architecture diagram.
- Updated the hosted frontend to use the ParseOtter icon in the product header and browser icons.
- Clarified GitHub repository metadata recommendations.

## Why This Release Exists

`v0.1.0` remains the initial open-source release. `v0.1.1` brings the latest public documentation and branding state into the release archive without rewriting the existing `v0.1.0` tag.

## Verification

- GitHub Actions CI passed on the release base commit.
- GitHub Security Scan passed on the release base commit.
- Hosted production conversion was verified through a real browser flow after the current public code was deployed.
- README, deployment guide, screenshot, architecture diagram, and flow recording were verified from GitHub raw assets.

## Notes For Operators

- Review `DEPLOYMENT.md` before using real Cloudflare or Modal resources.
- Replace all placeholder domains, account IDs, bucket names, endpoints, and secrets before deployment.
- Use fresh D1/R2/Modal resources for a first public self-hosted install.
- Review upstream `marker-pdf` behavior and terms for your use case.
