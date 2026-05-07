# Security Policy

## Supported Versions

Security fixes are handled for the current public release line. Pre-release private deployments and forks are not supported by this repository unless a maintainer explicitly says otherwise.

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities, exposed credentials, abuse bypasses, or data exposure reports.

Report security issues privately through GitHub private vulnerability reporting
for this repository, if it is enabled. If private vulnerability reporting is not
available, contact the repository maintainers through the published GitHub
organization or maintainer contact path before sharing details.

Include:

- A short description of the issue.
- Affected component: frontend, API Worker, Modal converter, deployment docs, or infrastructure config.
- Reproduction steps using synthetic or safe-to-share data.
- Impact and any known mitigations.
- Whether credentials, uploaded files, task metadata, callbacks, or user data may be exposed.

## Secret Handling

Never commit:

- Cloudflare account IDs if they identify a private account.
- Worker secrets.
- Modal secrets.
- R2 access keys.
- Turnstile secret keys.
- GA4 API secrets.
- Production URLs that are not meant to be public.

If a secret is committed or posted publicly, rotate it immediately in Cloudflare or Modal. Removing it from a later commit is not enough.

## Deployment Responsibility

Self-hosters are responsible for:

- Their own privacy policy and user notices.
- Cloudflare and Modal account security.
- R2 bucket access controls and lifecycle settings.
- D1 retention and backup policies.
- Worker and Modal logs.
- Abuse controls, rate limits, and Turnstile configuration.
