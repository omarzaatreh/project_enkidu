/**
 * Generates SYNTHETIC results.jsonl via the real runner with deterministic
 * mock adapters — no API keys, no cost. Use it to iterate on the report
 * template (`npm run render`) before or between real runs.
 *
 *   npx tsx scripts/smoke-results.ts [config-path]
 *
 * Never mix with real data: it wipes results/ first.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { runGeneration } from "../lib/runner.js";
import { extractionCellId } from "../lib/shared/cellId.js";
import type { Adapter, Cell, GenerationCell, Provider, RunConfig } from "../lib/types.js";

const configPath = process.argv[2] ?? "config/tikit.example.json";
const config = JSON.parse(readFileSync(configPath, "utf8")) as RunConfig;

rmSync("results", { recursive: true, force: true });
mkdirSync("results", { recursive: true });
const append = (c: Cell): void => appendFileSync("results/results.jsonl", JSON.stringify(c) + "\n");

// Deterministic per (provider, prompt): client mentioned ~40% on openai/anthropic, rarely on perplexity.
const mk = (provider: Provider): Adapter => async (req) => {
  const seed = [...`${provider}|${req.promptText}`].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const mention = provider === "perplexity" ? seed % 7 === 0 : seed % 5 < 2;
  const text = mention
    ? `Top picks include Obviously, The Goat Agency, and ${config.client.name} for boutique creator matchmaking.`
    : `Top picks include Obviously, The Goat Agency, and Ubiquitous for most brands.`;
  return {
    responseText: text,
    citations: [
      { url: "https://influencermarketinghub.com/agencies", domain: "influencermarketinghub.com", title: "Top Agencies 2026" },
      ...(provider === "perplexity"
        ? [{ url: "https://www.byrdie.com/best-creator-agencies", domain: "byrdie.com", title: "Best Creator Agencies" }]
        : []),
    ],
  };
};

const adapters: Partial<Record<Provider, Adapter>> = {};
for (const p of Object.keys(config.models) as Provider[]) adapters[p] = mk(p);
await runGeneration({
  config,
  adapters,
  existingCellIds: new Set(),
  append,
});

const cells = readFileSync("results/results.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Cell);
for (const c of cells) {
  if (c.kind === "generation" && c.status === "ok") {
    const gen = c as GenerationCell;
    const brands = [
      "Obviously",
      "The Goat Agency",
      gen.responseText?.includes(config.client.name) ? config.client.name : "Ubiquitous",
    ];
    append({
      kind: "extraction",
      cellId: extractionCellId({ generationCellId: gen.cellId, extractorModel: "smoke" }),
      generationCellId: gen.cellId,
      extractorModel: "smoke",
      status: "ok",
      brands,
      timestamp: new Date().toISOString(),
    });
  }
}
console.log(`Synthetic results written for ${config.client.name}: results/results.jsonl`);
