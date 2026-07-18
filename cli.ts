/**
 * enkidu CLI — two commands, deliberately separate (eng review 6A):
 *
 *   tsx cli.ts run    --config config/tikit.json     # PAID: ~300 grounded calls
 *   tsx cli.ts render --config config/tikit.json     # FREE: results.jsonl → report.html
 *
 * `run` is resumable: cells append to results.jsonl as they complete; on
 * restart, ok cells are skipped (content-hash IDs — edited prompts re-run
 * automatically). Failed cells are always retried on the next run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cell, GenerationCell, Provider, RunConfig, TrendPoint } from "./lib/types.js";
import { MIN_SAMPLES_PER_CELL, PROVIDER_OUTAGE_THRESHOLD } from "./lib/types.js";
import { makeAdapters } from "./lib/adapters/index.js";
import { enabledProviders, runExtraction, runGeneration } from "./lib/runner.js";
import { curationCandidates } from "./lib/ui/curation.js";
import { isOutage, renderFromResults } from "./lib/ui/renderPipeline.js";

// ---------- tiny arg/env plumbing (explicit > clever; no deps) ----------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function loadConfig(path: string): RunConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as RunConfig;
  if (!cfg.promptSet?.version) fail("config: promptSet.version is required (bump on any prompt edit)");
  if (!cfg.promptSet.prompts?.length) fail("config: promptSet.prompts is empty");
  if (!cfg.client?.name || !cfg.client?.domain) fail("config: client.name and client.domain are required");
  if (enabledProviders(cfg).length === 0)
    fail('config: models is empty — list at least one provider, e.g. {"anthropic": "claude-sonnet-5"}');
  if (cfg.samplesPerPrompt < MIN_SAMPLES_PER_CELL)
    console.warn(
      `⚠ samplesPerPrompt=${cfg.samplesPerPrompt} is below the reporting minimum of ${MIN_SAMPLES_PER_CELL} — ` +
        `every prompt would be excluded as "insufficient samples". Use ${MIN_SAMPLES_PER_CELL} or more.`,
    );
  return cfg;
}

function loadCells(path: string): Cell[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Cell);
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------- commands ----------

async function cmdRun(): Promise<void> {
  loadDotEnv();
  const configPath = arg("config") ?? fail("--config <path> is required");
  const resultsPath = arg("results", "results/results.jsonl")!;
  const config = loadConfig(configPath);

  const providers = enabledProviders(config);
  const envKey: Record<Provider, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    perplexity: "PERPLEXITY_API_KEY",
  };
  const keys: Partial<Record<Provider, string>> = {};
  for (const p of providers) {
    keys[p] = process.env[envKey[p]] ?? fail(`${envKey[p]} missing (.env) — required by enabled provider "${p}"`);
  }
  // The extraction pass always runs on a cheap Anthropic model, so its key is
  // required even when anthropic isn't among the measured providers.
  const anthropicKey =
    keys.anthropic ?? process.env.ANTHROPIC_API_KEY ?? fail("ANTHROPIC_API_KEY missing (.env) — the extraction pass requires it");

  mkdirSync(dirname(resultsPath), { recursive: true });
  const cells = loadCells(resultsPath);
  const okGeneration = cells.filter(
    (c): c is GenerationCell => c.kind === "generation" && c.status === "ok",
  );
  const existingCellIds = new Set(okGeneration.map((c) => c.cellId));
  const existingOkByProvider: Partial<Record<Provider, number>> = {};
  for (const c of okGeneration) existingOkByProvider[c.provider] = (existingOkByProvider[c.provider] ?? 0) + 1;

  const append = (cell: Cell): void => appendFileSync(resultsPath, JSON.stringify(cell) + "\n");

  const estCalls = config.promptSet.prompts.length * providers.length * config.samplesPerPrompt;
  console.log(
    `Run: ${config.promptSet.prompts.length} prompts × ${providers.length} provider(s) [${providers.join(", ")}] × ${config.samplesPerPrompt} samples = ${estCalls} calls`,
  );
  if (existingCellIds.size > 0) console.log(`Resuming — ${existingCellIds.size} completed cells will be skipped.`);

  const outcome = await runGeneration({
    config,
    adapters: makeAdapters(keys),
    existingCellIds,
    existingOkByProvider,
    append,
    onProgress: (p) => {
      if (p.done % 25 === 0 || p.done === p.total)
        console.log(`  generation: ${p.done}/${p.total} (${p.failed} failed)`);
    },
  });

  console.log("Extraction pass (cheap model, resumable)…");
  // Only enabled providers' cells are extracted — old cells from providers
  // removed from the config must not spend extraction budget.
  const enabledSet = new Set(providers);
  const allCells = loadCells(resultsPath).filter(
    (c) => c.kind === "extraction" || enabledSet.has(c.provider),
  );
  const extProgress = await runExtraction({
    cells: allCells,
    client: config.client,
    anthropicApiKey: anthropicKey,
    append,
    onProgress: (p) => {
      if (p.done % 50 === 0 || p.done === p.total)
        console.log(`  extraction: ${p.done}/${p.total} (${p.failed} failed)`);
    },
  });

  // Curation candidates: discovered brands not yet in config.competitors.
  // Filling that array is what populates the citation-gap table and makes
  // the competitor bars authoritative instead of raw-extraction guesses.
  // (Shared with the cockpit's curation screen via lib/ui/curation.ts.)
  const currentPromptTexts = new Set(config.promptSet.prompts.map((p) => p.text));
  const candidates = curationCandidates(loadCells(resultsPath), config, currentPromptTexts);
  if (candidates.length > 0) {
    const top = candidates.slice(0, 15);
    console.log(`\nDiscovered competitor candidates (add the real ones to "competitors" in ${configPath}):`);
    for (const { name, count } of top) console.log(`  ${String(count).padStart(3)}× ${name}`);
  }

  if (outcome.outageProviders.length > 0) {
    console.error(
      `\n⚠ RUN HELD: provider(s) below ${PROVIDER_OUTAGE_THRESHOLD * 100}% completion: ${outcome.outageProviders.join(", ")}.\n` +
        `  Re-run \`npm run run\` later to fill the gaps (resume is automatic), or render\n` +
        `  anyway with \`npm run render -- --config ${configPath} --acknowledge-outage\`.`,
    );
    process.exit(2);
  }
  console.log(`Done. generation failed: ${outcome.progress.failed}, extraction failed: ${extProgress.failed}.`);
  console.log(`Next: npm run render -- --config ${configPath}`);
}

async function cmdRender(): Promise<void> {
  const configPath = arg("config") ?? fail("--config <path> is required");
  const resultsPath = arg("results", "results/results.jsonl")!;
  const outPath = arg("out", join("reports", `report-${new Date().toISOString().slice(0, 10)}.html`))!;
  const trendPath = arg("trend", "results/trend.json")!;
  const config = loadConfig(configPath);

  const cells = loadCells(resultsPath);
  if (cells.length === 0) fail(`no cells in ${resultsPath} — run \`npm run run\` first`);

  const priorTrend: TrendPoint[] = existsSync(trendPath)
    ? (JSON.parse(readFileSync(trendPath, "utf8")) as TrendPoint[])
    : [];

  // Render core is shared with POST /api/render via lib/ui/renderPipeline.ts.
  // Outage guard: rendering a report with a dead provider column is a founder
  // decision (design doc report-level failure policy), not a default.
  const result = renderFromResults({
    config,
    cells,
    priorTrend,
    acknowledgeOutage: process.argv.indexOf("--acknowledge-outage") !== -1,
  });
  if (isOutage(result)) {
    fail(
      `provider(s) below ${PROVIDER_OUTAGE_THRESHOLD * 100}% completion: ${result.outageProviders.join(", ")}. ` +
        `Re-run to fill gaps, or pass --acknowledge-outage to ship with the caveat.`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.html);

  mkdirSync(dirname(trendPath), { recursive: true });
  writeFileSync(trendPath, JSON.stringify(result.trend, null, 2));

  console.log(`Report written: ${outPath}`);
  console.log(`Deploy: ./scripts/deploy.sh ${outPath}`);
  console.log(`Pre-send ritual: spot-check 5-10 prompts in the consumer apps first (README).`);
}

const cmd = process.argv[2];
if (cmd === "run") await cmdRun();
else if (cmd === "render") await cmdRender();
else fail(`usage: tsx cli.ts <run|render> --config <path> [--results <path>] [--out <path>]`);
