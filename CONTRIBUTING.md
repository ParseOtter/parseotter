# Contributing

Thanks for improving ParseOtter. Keep changes focused, reproducible, and safe to publish.

## Before You Open A PR

- Do not commit real credentials, private account IDs, bucket names, or production-only domains.
- Use synthetic or safe-to-share test documents.
- Update docs when configuration, deployment, API behavior, retention, or user-visible behavior changes.
- Include focused tests for behavior changes.
- Run the checks for the areas you touched.

## Local Setup

Frontend:

```bash
cd frontend
yarn install
cp .env.example .env
yarn typecheck
yarn test
yarn build
```

API Worker:

```bash
cd api-worker
yarn install
cp .dev.vars.example .dev.vars
yarn cf-typegen
yarn typecheck
yarn test
```

Modal converter:

```bash
cd modal-converter
uv sync
uv run pytest
```

## Pull Request Checklist

- Tests run locally, or skipped with a clear reason.
- Docs updated for any user-facing or operator-facing change.
- New fixtures are synthetic and documented in `docs/FIXTURES.md`.
- New environment variables are documented in the affected README and deployment guide.
- No generated files, local caches, real secrets, or private process notes are included.
- Security-sensitive behavior was reviewed against `SECURITY.md`.

## Code Style

- Prefer existing local patterns over new abstractions.
- Keep Cloudflare Worker, frontend, and Modal responsibilities separate.
- Avoid compatibility code for private pre-release data unless a migration task explicitly requires it.
- Keep public docs in English.
- Avoid claims that depend on changing third-party pricing, star counts, or rankings.

## Security Reports

Do not report vulnerabilities or exposed credentials in public issues. Follow `SECURITY.md`.

## Maintainer Release Process

Use the manual `Release` GitHub Actions workflow for public releases.

Before running it:

- Update `CHANGELOG.md` with a dated section such as `## v0.1.2 - 2026-05-12`.
- Add `docs/RELEASE_NOTES_vX.Y.Z.md`.
- Add the new release notes link to `README.md` when the notes should be discoverable from the documentation index.
- Push the release-preparation commit to `main`.
- Wait for `CI` and `Security Scan` to pass on that commit.

Run `Actions` -> `Release` with:

- `tag`: `vX.Y.Z`
- `confirm`: `release vX.Y.Z`
- `latest`: `true` for the normal current release

The workflow creates the annotated tag and GitHub Release from `main` after verifying the release notes, changelog entry, and required checks.

After publishing:

- Confirm GitHub shows the new tag as the latest release.
- Confirm the release body came from `docs/RELEASE_NOTES_vX.Y.Z.md`.
- Confirm `README.md` and `CHANGELOG.md` are correct on GitHub.
- Check `https://www.parseotter.com/` and `https://api.parseotter.com/health`.

## License

By contributing, you agree that your contribution is licensed under the repository's AGPL-3.0 license.
