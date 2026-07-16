/**
 * Synthetic cell/config builders for Lane B tests.
 * Pure construction helpers — cell IDs use the real content-hash functions
 * so extraction cells join to generation cells exactly as in production.
 */

import { extractionCellId, generationCellId } from "../lib/shared/cellId.js";
import type {
  BrandConfig,
  Citation,
  ExtractionCell,
  GenerationCell,
  Provider,
  RunConfig,
} from "../lib/types.js";

export function makeBrand(
  name: string,
  aliases: string[] = [],
  domain = `${name.toLowerCase().replace(/\s+/g, "")}.com`,
): BrandConfig {
  return { name, aliases, domain };
}

export interface GenCellOpts {
  promptText?: string;
  provider?: Provider;
  model?: string;
  sampleIndex?: number;
  status?: "ok" | "failed";
  responseText?: string;
  citations?: Citation[];
}

export function makeGenCell(opts: GenCellOpts = {}): GenerationCell {
  const promptText = opts.promptText ?? "best legal tech tools";
  const provider = opts.provider ?? "openai";
  const model = opts.model ?? "gpt-test";
  const groundingConfig = "web_search:on";
  const sampleIndex = opts.sampleIndex ?? 0;
  const status = opts.status ?? "ok";
  const cell: GenerationCell = {
    kind: "generation",
    cellId: generationCellId({ promptText, provider, model, groundingConfig, sampleIndex }),
    promptId: "p1",
    promptText,
    provider,
    model,
    groundingConfig,
    sampleIndex,
    status,
    citations: opts.citations ?? [],
    timestamp: "2026-07-17T00:00:00.000Z",
  };
  if (status === "ok") {
    cell.responseText = opts.responseText ?? "a perfectly generic answer";
  } else {
    cell.error = "synthetic failure";
  }
  return cell;
}

export function makeExtCell(
  gen: GenerationCell,
  brands: string[],
  status: "ok" | "failed" = "ok",
): ExtractionCell {
  const extractorModel = "cheap-extractor";
  const cell: ExtractionCell = {
    kind: "extraction",
    cellId: extractionCellId({ generationCellId: gen.cellId, extractorModel }),
    generationCellId: gen.cellId,
    extractorModel,
    status,
    timestamp: "2026-07-17T00:00:00.000Z",
  };
  if (status === "ok") cell.brands = brands;
  else cell.error = "synthetic extraction failure";
  return cell;
}

export function makeCitation(domain: string, title?: string): Citation {
  return { url: `https://${domain}/article`, domain, title };
}

export interface ConfigOpts {
  client?: BrandConfig;
  competitors?: BrandConfig[];
  prompts?: string[];
  samplesPerPrompt?: number;
  version?: string;
}

export function makeConfig(opts: ConfigOpts = {}): RunConfig {
  const promptTexts = opts.prompts ?? ["best legal tech tools"];
  return {
    client: opts.client ?? makeBrand("TIkit", ["Tikit Ltd", "tickit"], "tikit.com"),
    competitors: opts.competitors ?? [],
    promptSet: {
      version: opts.version ?? "v1",
      prompts: promptTexts.map((text, i) => ({ id: `p${i + 1}`, text })),
    },
    models: {
      openai: "gpt-test",
      anthropic: "claude-test",
      perplexity: "sonar-test",
    },
    samplesPerPrompt: opts.samplesPerPrompt ?? 5,
    whiteLabel: { agencyName: "Test Agency", accentColor: "#123456" },
    dateRange: { from: "2026-07-01", to: "2026-07-17" },
  };
}
