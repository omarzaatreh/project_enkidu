# Architecture

enkidu measures how often AI assistants (OpenAI/ChatGPT, Anthropic/Claude,
Perplexity) mention a brand across a versioned set of buyer-intent prompts, then
renders a white-labelable one-page HTML report. This document is the map: the
data model, the layering, and the seams that keep the local tool cheap to grow
into a hosted one.

For how to *use* it, see [README.md](README.md). This is how it's *built*.

## The one idea: content-addressed cells

Every unit of measured work is a **cell**, identified by a hash of its own
content — not its position. Cells are appended, one JSON object per line, to
`results/<config>.jsonl`. That append-only log is the entire source of truth;
everything else is a pure function over it.

Two kinds, discriminated by `kind` ([types.ts](backend/core/types.ts)):

- **GenerationCell** — one `(promptText × provider × model × sampleIndex)` API
  call. Carries the prose `responseText` and parsed `citations` when `ok`.
  `cellId = sha256("gen|" + promptText + provider + model + groundingConfig + sampleIndex)`.
- **ExtractionCell** — one competitor-discovery pass over a completed generation
  cell. Carries the `brands[]` the extractor found in the prose.
  `cellId = sha256("ext|" + generationCellId + extractorModel + extractionPromptVersion)`.

Hashing the prompt **text** (not its index) is the load-bearing decision
([cellId.ts](backend/core/shared/cellId.ts)). Editing a prompt changes its hash,
so its old cells stop matching on the next run and the runner re-buys exactly
what changed — nothing else. Positional IDs would silently serve yesterday's
answer under today's wording. The same logic hashes the grounding config into
generation cells and the extraction-prompt version (`EXTRACTION_PROMPT_VERSION`,
currently `"v2"`) into extraction cells: improving the extractor invalidates
stale extractions instead of reusing them.

**Resume falls out for free.** A run lists the task set (`prompts × providers ×
samples`), skips any `cellId` already present in the log, and buys the rest. A
crash mid-run costs only the unbought cells.

## Layering: pure core, then services, then edges

Dependencies flow one direction. Nothing inner imports anything outer.

```
  cli/  ─┐
         ├─►  backend/services/  ─►  backend/core/
  app/  ─┘      (I/O, app logic)      (pure engine)
```

- **`backend/core/`** — the measurement engine, framework-free and I/O-free:
  provider adapters, the run loop ([runner.ts](backend/core/runner.ts)),
  extraction, aggregation, insights, and HTML rendering. Pure functions over
  cells; the caller supplies the loaded cell set and an append callback. This is
  what makes the whole thing testable without a network or a filesystem — the
  190-test suite runs in ~350ms because the core never touches either.
- **`backend/services/`** — application logic shared by the CLI and the cockpit:
  the config store, run manager, render pipeline, curation, insights read-path,
  progress, and cost estimate. This layer owns disk and process concerns.
- **`app/`** — the Next.js cockpit. Pages plus **thin** API routes that are
  little more than wrappers over `backend/services`. Business logic does not
  live in route handlers.
- **`cli/`** — the command-line entry point, a second consumer of the same
  services.

A hard constraint enforces the boundary: `backend/services` runs under the root
`tsconfig` and **cannot import `app/`**. The on-disk layout it needs (results
paths, lock path) is duplicated in [app/lib/contract.ts](app/lib/contract.ts)
and kept in sync by hand — `contract.ts` is the one file both sides read for the
API/route/path shapes.

## The RunDriver seam

One active run at a time, guarded by an atomically-created lockfile at
`results/.run.lock`. Today that's **`LocalRunDriver`**
([runManager.ts](backend/services/runManager.ts)): it starts the run in-process,
broadcasts progress over an `EventEmitter` for SSE, and writes cells to disk as
they complete. Progress is *also* derivable from the log itself
([progress.ts](backend/services/progress.ts)), so a subscriber that attached
after a tick still catches up from disk instead of missing the emitter.

This is the seam the hosted path (Path B: Inngest + Supabase, multi-tenant)
swaps against. An `InngestRunDriver` slots in behind the same `start` / `active`
surface; the `app/api/runs/*` routes and all business logic stay put. Keeping
that surface small is the reason the local-to-hosted port is cheap rather than a
rewrite.

## The run pipeline

```
  task list = prompts × providers × samples
       │  skip cellIds already in the log (resume)
       ▼
  p-limit(3 per provider) ──► adapters (callWithRetry inside)
       │  append each cell the instant it completes
       ▼
  outage guard: any provider < 50% ok → hold the report
       ▼
  extraction pass: cheap-model brand extraction per ok generation cell
```

Generation runs concurrently, capped at `PER_PROVIDER_CONCURRENCY = 3` per
provider. If a provider's ok-fraction falls below `PROVIDER_OUTAGE_THRESHOLD =
0.5`, that's a provider outage and the report is held rather than rendered on
half the data (a founder decision, not a silent average). Extraction then runs a
cheap model (`claude-haiku-4-5`) over each ok generation cell to surface the
brands named in its prose, feeding the competitor-discovery / curation flow.

## Two read paths, one filter

The log feeds two consumers that must never disagree about *which cells count*,
so both go through the same filter — `filterToCurrentCells`
([cellFilter.ts](backend/core/cellFilter.ts)), the exact filter the render
pipeline applies (enabled providers, current prompt set, orphan cells dropped).

- **The report** — [aggregate.ts](backend/core/aggregate.ts) computes figures
  over completed cells with **sufficiency** applied: a cell with fewer than
  `MIN_SAMPLES_PER_CELL = 3` ok samples is INSUFFICIENT and excluded. Share of
  voice and stat cards are computed here directly (not via `computeInsights`) so
  the report's hero line can never disagree with its own stat cards.
- **The cockpit Insights page** — [insights.ts](backend/core/insights.ts)
  (`computeInsights`) counts **all** ok cells with no sufficiency cutoff, so the
  Insights page always shows the raw `x/n`. The divergence from the report is
  intentional and disclosed in the UI.

Because both start from the same filtered cell set, they agree on the universe;
they differ only in the sufficiency lens, on purpose.

## Rendering

[render.ts](backend/core/render.ts) is pure: `AggregateResult → HTML string`,
with four states, `noindex`, white-label (agency name, logo, accent color), and
print styles. [renderPipeline.ts](backend/services/renderPipeline.ts) is the
service around it — load cells, filter, run the outage guard, aggregate, splice
the trend point, write the file. The report filename derives from
`config.dateRange.to`, so re-rendering the same period overwrites one file
(idempotent) instead of stamping a new UTC render-day file each time.

All report/aggregate schema fields added after v0.1 are **optional**, so older
`results/*.trend.json` files still parse without migration.

## Security posture

- **Config names are validated at every name→path site.** A single
  `isValidConfigName` (`^[A-Za-z0-9._-]+$`, rejects `..`) in
  [configStore.ts](backend/services/configStore.ts) gates every route that turns
  a name into a `results/` or `config/` path; invalid names 400.
- **Untrusted strings are coerced before they reach an HTML context.** In the
  report, `accentColor` is coerced to a safe hex ([render.ts](backend/core/render.ts)
  `safeAccentColor`, default `#1a56db`) before entering CSS. In the cockpit's
  answer explorer, citation hrefs are rendered only when http(s)
  ([app/insights/page.tsx](app/insights/page.tsx) `safeHttpUrl`).
- **Keys stay server-side.** Provider keys live in `.env`, read only by
  `backend/services`; the cockpit binds to `127.0.0.1`.
- **Client data never enters git.** `results/`, `reports/`, and real
  `config/*.json` are gitignored; only `config/*.example.json` is committed.

## Where to start reading

- The data model → [types.ts](backend/core/types.ts)
- Why resume works → [cellId.ts](backend/core/shared/cellId.ts)
- The run loop → [runner.ts](backend/core/runner.ts) +
  [runManager.ts](backend/services/runManager.ts)
- Report vs cockpit numbers → [aggregate.ts](backend/core/aggregate.ts) +
  [insights.ts](backend/core/insights.ts) + [cellFilter.ts](backend/core/cellFilter.ts)
- The API/route/path contract → [app/lib/contract.ts](app/lib/contract.ts)
