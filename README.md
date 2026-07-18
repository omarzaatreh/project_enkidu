# enkidu — AI Visibility Report

Measures how often AI assistants (ChatGPT, Claude, Perplexity) mention a brand
across a versioned set of buyer-intent prompts, and renders a white-labelable
one-page HTML report. Script-first v1 per the design doc
(`~/.gstack/projects/project_enkidu/omaral-zaatreh-nogit-design-20260717-010000.md`).

## Usage

```bash
cp .env.example .env       # add the three API keys
npm run capture-fixtures   # once: replace synthetic fixtures with real captures
npm run run -- --config config/tikit.json          # paid: ~300 grounded calls → results/results.jsonl
npm run render -- --from results/results.jsonl     # free: results → reports/report.html
npm test
```

`run` is resumable: every completed call is appended to `results.jsonl` keyed by
a content hash of (prompt text, model, grounding config, sample index). Crash and
re-run — completed cells are skipped, edited prompts re-run automatically.

## Cost dial: model selection and sample count

The config file is the parameter interface. `models` keys select which providers
run (one = cheap report, three = full report); `samplesPerPrompt` sets depth
(minimum 3 — below that every prompt is excluded as "insufficient samples").
A future hosted UI writes this same config.

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

## Pre-send ritual (mandatory)

Before any report goes to a client: spot-check 5–10 prompts by hand in the
consumer ChatGPT / Claude / Perplexity apps and reconcile with the report's
numbers. The report shows two labeled figures — "Mentioned in answers" (prose)
and "Cited as a source" (citation metadata) — because a buyer's eyeball check
counts citation chips too.

## Data hygiene

`results/` and `reports/` are gitignored — client competitive data never enters
git history. Back `results.jsonl` up off-machine (any synced folder). Report
URLs are best-effort immutable until the hosted version.
