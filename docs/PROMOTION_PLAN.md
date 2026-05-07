# ParseOtter Promotion Plan

Status: public-ready draft. Verify external facts and links again immediately
before launch.

## Positioning

ParseOtter is an open-source, self-hostable PDF/EPUB-to-Markdown conversion
service powered by marker, Cloudflare Workers, R2, D1, Durable Objects, and
Modal GPU inference.

Use this short description consistently:

> ParseOtter packages document upload, object storage, async task state, GPU
> conversion, Markdown preview, ZIP download, retention, and abuse controls into
> a deployable service for PDF/EPUB-to-Markdown workflows.

Preferred calls to action:

- Try the hosted version: https://www.parseotter.com/
- Deploy your own instance.
- Read the architecture and deployment guide.

Avoid:

- Using any label for the hosted version other than "hosted version",
  "live service", or "working hosted version".
- Claiming unlimited free usage.
- Claiming "first", "only", or market leadership unless independently verified
  immediately before publication.
- Using stale competitor star counts or pricing in public copy.
- Aggressive comparisons with upstream projects. ParseOtter builds on marker; it
  does not replace marker for CLI/library users.

## Audience

Primary audiences:

| Audience | Need | Message |
| --- | --- | --- |
| RAG pipeline builders | Clean Markdown from PDFs and EPUBs without building upload, storage, job state, and GPU orchestration themselves. | A deployable conversion service for document ingestion pipelines. |
| Self-hosters and infrastructure teams | Control where documents are stored and processed. | Own the stack: Cloudflare storage/state plus Modal GPU conversion. |
| Researchers and technical teams | Convert papers, reports, and books into inspectable Markdown and assets. | Browser upload, Markdown preview, ZIP results, and short retention. |
| Open source contributors | A practical reference architecture for Workers plus GPU inference. | A focused codebase with React, Hono, D1, R2, Durable Objects, and Modal. |

## Messaging Pillars

- Full stack, not just a wrapper: frontend, API Worker, R2 upload/download, D1
  state, Durable Object coordination, Modal dispatch, and callback verification.
- Self-hostable by design: deploy with your own Cloudflare and Modal accounts.
- Good operational defaults: 48-hour retention, rate limits, Turnstile support,
  HMAC-signed Modal callbacks, and anonymous usage controls.
- Built on proven infrastructure: marker for conversion, Cloudflare for edge
  compute/storage/state, and Modal for GPU inference.
- Useful hosted version: a working service at https://www.parseotter.com/ for
  trying the product before deploying it.

## Pre-Launch Checklist

- [ ] README first screen includes ParseOtter name, value proposition, hosted
      version link, screenshot/GIF, and quick start.
- [ ] `DEPLOYMENT.md` has been tested by a fresh reader or clean environment.
- [ ] Public docs avoid private process notes and unstable competitor data.
- [ ] Screenshots and recordings use synthetic or public-domain input files.
- [ ] Secret scan and public tree audit pass.
- [ ] Frontend, API Worker, and Modal converter tests pass.
- [ ] Repository metadata is ready: description, topics, homepage, Issues, and
      optional Discussions.
- [ ] `v0.1.0` release notes are drafted.
- [ ] A short launch post and first-comment explanation are prepared.

## Assets

Required:

- Upload screen screenshot.
- Markdown preview screenshot.
- Short recording or GIF showing upload, processing, preview, and ZIP download.
- Architecture diagram showing browser, frontend Worker, API Worker, D1, R2,
  Durable Object, and Modal converter.

Optional:

- Social preview image.
- Short deployment terminal recording.
- Architecture blog post diagram.

Asset rules:

- Do not use private, customer, or copyrighted documents.
- Prefer a small synthetic PDF/EPUB fixture that can be checked into the repo.
- Store public assets under `docs/assets/`.

## Launch Channels

Priority channels:

| Priority | Channel | Purpose |
| --- | --- | --- |
| P1 | GitHub release | Source of truth for `v0.1.0`. |
| P1 | Hacker News Show HN | Early technical feedback. |
| P2 | X / LinkedIn technical thread | Architecture and hosted-version awareness. |
| P2 | Self-hosting and RAG communities | Reach users who care about deployment and document ingestion. |
| P3 | Cloudflare and Modal communities | Ecosystem feedback and validation. |
| P3 | Technical blog post | Durable explanation of architecture and tradeoffs. |

Before posting to any community, check the current rules for that community.
Prefer a useful technical write-up over a bare repository link.

## Launch Copy

Short version:

> ParseOtter is an open-source, self-hostable PDF/EPUB-to-Markdown conversion
> service powered by marker, Cloudflare Workers/R2/D1, and Modal GPU inference.
> It includes the pieces most teams otherwise have to build around a converter:
> upload handling, async jobs, task state, result storage, preview, downloads,
> retention, and abuse controls.

Show HN title candidates:

- `Show HN: ParseOtter - self-hostable PDF/EPUB-to-Markdown conversion service`
- `Show HN: ParseOtter - a full-stack marker-powered document converter`

First comment outline:

- State the problem: high-quality PDF/EPUB conversion is usually a library or
  CLI, but production use needs upload, storage, async jobs, GPU orchestration,
  status polling, downloads, retention, and abuse controls.
- Explain the architecture: React frontend, Cloudflare Worker API, R2, D1,
  Durable Objects, Modal GPU inference, marker.
- Link to the hosted version and repository.
- Mention AGPL-3.0 clearly.
- Ask for deployment-doc feedback and hard PDF/EPUB examples that are safe to
  share.

## Timeline

### 3-7 Days Before Launch

- Share the repository privately with a small group of developers who understand
  RAG, self-hosting, Cloudflare, Modal, or document conversion.
- Ask reviewers to follow the deployment guide, not only try the hosted version.
- Fix unclear setup steps immediately.
- Finalize screenshots, recording, architecture diagram, and release notes.
- Re-run external fact checks for any pricing or comparison statements.

### Launch Day

- Publish the GitHub repository or release.
- Confirm hosted version and docs links work.
- Post to the selected primary channel.
- Stay available for several hours to answer questions.
- Record issues that reveal documentation gaps.

### Week 1

- Triage deployment issues quickly.
- Add FAQ entries based on repeated questions.
- Open good-first-issue items only after the first feedback wave is understood.
- Track conversion failures and hosted-version errors.

### Weeks 2-4

- Publish a deployment walkthrough.
- Publish a RAG workflow article.
- Release a patch version if launch feedback reveals setup or reliability bugs.
- Invite focused feedback from marker, Cloudflare, Modal, and self-hosting users
  where appropriate.

## Metrics

Repository metrics:

- Stars and clones.
- README hosted-version click-through.
- Issues with real deployment feedback.
- External pull requests.

Hosted-version metrics:

- Visits from GitHub and launch posts.
- Upload start rate.
- Conversion success rate.
- Median and p95 conversion time.
- Failed task rate by error code.
- Estimated cost per successful conversion.

Community metrics:

- Quality of comments and deployment questions.
- Mentions in newsletters or community roundups.
- Documentation changes driven by user feedback.

## Risk Controls

| Risk | Control |
| --- | --- |
| Outdated pricing or competitor claims | Avoid exact claims in evergreen docs; verify immediately before launch posts. |
| Users think hosted version is a toy | Use "hosted version" or "working hosted version" consistently. |
| Users expect unlimited free conversion | Document limits, retention, and self-hosting requirements clearly. |
| Secret or production identifier leak | Run manual scans plus a dedicated secret scanner before publication. |
| Upstream marker terms are misunderstood | Link to upstream marker and tell users to review upstream terms for their use case. |
| Launch feedback focuses on deployment gaps | Prioritize `DEPLOYMENT.md` fixes before feature work. |
