# enkidu — AI Visibility Report

Measures how often AI assistants (ChatGPT, Claude, Perplexity) mention a brand
across a versioned set of buyer-intent prompts, and renders a white-labelable
one-page HTML report. Run it from a local web cockpit or the command line — both
read and write the same config files, so they're interchangeable.

## Cockpit (web UI)

```bash
cp .env.example .env    # add your API keys
npm install
npm run ui              # http://127.0.0.1:4600
```

A local, single-user web app that drives the whole workflow:

- **Clients** — client name, domain, aliases, industry, white-label branding (accent-color picker + live logo preview), competitors, and the report's date range
- **Prompts** — edit the buyer-intent prompts (the prompt-set version auto-bumps on any edit); each prompt shows a per-provider "mentioned x/n" performance chip once it has results
- **Run** — pick providers and sample count, set the report period, see a live resume-aware cost estimate, then watch the run stream with per-provider progress bars, elapsed time, and per-cell failure detail (the actual error text, not just a count)
- **Insights** — read your results without rendering a report: a prompt × provider mention heatmap, overall share-of-voice, a citation-domain leaderboard, competitor co-occurrence, and an answer explorer that opens the real AI responses per sample with brand mentions highlighted and citations listed
- **Curation** — promote discovered competitors into the report with a checkbox; each candidate shows *why* it surfaced (which providers and prompts named it, plus a prose snippet), then re-render for free
- **Reports** — browse rendered reports by friendly title, filter to the selected config, preview inline, and re-render a stale one (older than its data) in one click

Bound to `127.0.0.1` only; API keys stay server-side and never reach the browser.

## CLI

```bash
npm run run -- --config config/full.example.json      # paid: grounded calls → results/results.jsonl
npm run render -- --config config/full.example.json   # free:  results → reports/report-<date>.html
npm test
```

`run` is resumable: every completed call is appended to `results.jsonl` keyed by
a content hash of (prompt text, model, grounding config, sample index). Crash and
re-run — completed cells are skipped, edited prompts re-run automatically.

## Cost dial: model selection and sample count

The config file is the parameter interface. `models` keys select which providers
run (one = cheap report, three = full report); `samplesPerPrompt` sets depth
(minimum 3 — below that every prompt is excluded as "insufficient samples").
The cockpit and the CLI both read and write this same config.

```bash
npm run run -- --config config/cheap.example.json   # anthropic-only, 3 samples
```

Cheap mode with 20 prompts: 20 × 1 provider × 3 samples = 60 grounded calls
(~$1) vs the full 20 × 3 × 5 = 300 (~$5). The extraction pass always uses a
cheap Anthropic model, so `ANTHROPIC_API_KEY` is required even when Anthropic
isn't among the measured providers. Note: cross-model comparison ("Claude
mentions you, ChatGPT doesn't") is the report's most persuasive block for
multi-model buyers — cheap mode trades it away, so use it for iteration and
first drafts, full mode for the client-facing send.

## The report

One self-contained, white-labeled HTML page. It leads with two labeled figures
per model — "Mentioned in answers" (prose) and "Cited as a source" (citation
metadata) — because a buyer's eyeball check counts citation chips too. Around
those it adds an overall share-of-voice line, a "where AI systems get their
information" source-domain leaderboard (the actionable GEO target list), a
verbatim pull-quote from a real answer, a per-prompt breakdown of which buyer
questions the client wins or loses, and a trend chart once there is more than
one run to compare.

## Pre-send ritual (mandatory)

Before any report goes to a client: spot-check 5–10 prompts by hand in the
consumer ChatGPT / Claude / Perplexity apps and reconcile with the report's
numbers. The Insights page and its answer explorer make this fast — you can
read the exact responses the numbers came from before you trust them.

## Project structure

- `backend/core/` — the measurement engine, framework-free: provider adapters, runner, extraction, aggregation, insights, HTML rendering
- `backend/services/` — application logic shared by the CLI and cockpit: config store, run manager, render pipeline, curation, insights, progress, cost estimate
- `app/` — the Next.js cockpit (pages + thin API routes over `backend/services`)
- `cli/` — the command-line entry point
- `config/*.example.json` — config templates; real client configs live in `config/*.json` and are gitignored
- `scripts/` — dev/ops scripts (fixture capture, synthetic smoke data, deploy)
- `test/` — Vitest suite and fixtures (`npm test`)

Dependencies flow one direction: `app` → `backend/services` → `backend/core`, with `cli` as a second consumer.

## Data hygiene

`results/`, `reports/`, and real `config/*.json` are gitignored — client
competitive data never enters git history. Back `results.jsonl` up off-machine
(any synced folder). Report URLs are best-effort immutable until the hosted version.
</content>
