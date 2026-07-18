# Changelog

All notable changes to enkidu are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-19

The cockpit stopped being analytically blind. It could run providers and render
a report, but it never surfaced what the AIs actually said. This release adds a
read-path over `results.jsonl`, a richer report, and a security hardening pass.

### Added
- **Analytics read-path** — pure `computeInsights` (`backend/core/insights.ts`)
  + `backend/services/insights.ts` + `/api/insights`, powering a new `/insights`
  page with an answer explorer.
- **Answer explorer surface** — `/api/answers` and `/api/runs/failures` for
  drilling into individual model responses and run failures.
- **Shared render state machine** — `app/components/RenderButton.tsx` reused
  across Run, Curation, and Reports; `app/components/Nav.tsx` adds active-route
  highlighting.
- **Report figures** for share-of-voice and trend, computed directly in
  `aggregate.ts` over completed cells so the report's SoV matches its stat cards
  by construction.

### Changed
- **Report/aggregate schema fields are now optional** so existing
  `results/*.trend.json` files still parse without migration.
- **Report filename derives from `config.dateRange.to`** instead of the UTC
  render day, making re-renders of the same period idempotent (overwrite one file).
- Extracted the report's orphan-filter into `backend/core/cellFilter.ts`
  (`filterToCurrentCells`) and shared it with insights, so cockpit numbers and
  the report can't diverge. Sufficiency divergence (insights counts all ok cells;
  the report applies `MIN_SAMPLES = 3`) is intentional and disclosed in the UI.

### Security
- Single `isValidConfigName` validator (`^[A-Za-z0-9._-]+$`, rejects `..`) in
  `configStore.ts`, asserted at every name-to-path site with 400s on routes.
- Citation hrefs restricted to http(s) only (`safeHttpUrl`).
- `accentColor` coerced to a safe hex before entering the report CSS context
  (`safeAccentColor`, default `#1a56db`), with a 400 on invalid PUT.

## [0.1.0] - 2026-07-18

Initial build of enkidu: a GEO (Generative Engine Optimization) tool that
measures how often AI assistants (ChatGPT/OpenAI, Claude/Anthropic, Perplexity)
mention a brand across a versioned set of buyer-intent prompts, then renders a
white-labelable one-page HTML report.

### Added
- **Measurement core** — typed cell-ID hashing, alias normalization, provider
  fixtures, and a capture script (the identity model for a prompt × provider cell).
- **Provider adapters** with `callWithRetry` across OpenAI, Anthropic, and
  Perplexity; provider selection driven by `config.models` keys; cheap-mode config.
- **Prose-only extraction and aggregation** with honest denominators, category-aware
  competitor extraction (v2, hashed prompt version), latest-wins dedupe, and trend
  point replacement.
- **Report renderer** — four states, `noindex`, white-label, and print styles.
- **CLI** (`run` / `render`) with a resumable runner and crash-resume E2E coverage.
- **Cockpit** — Next.js shell with API routes, a run manager with locking, and
  pages for clients, prompts, run, curation, and reports; orphaned-prompt cells
  excluded from reports, actionable outage render UI, and stale-report badges.

### Changed
- Reorganized into a top-level `backend/{core,services}` + `cli/` split, separate
  from the `app/` frontend; folded `fixtures/` into `test/fixtures` and `deploy/`
  into `scripts/` for a leaner repo root.

[0.2.0]: https://github.com/omarzaatreh/project_enkidu/releases/tag/v0.2.0
[0.1.0]: https://github.com/omarzaatreh/project_enkidu/releases/tag/v0.1.0
