/**
 * Orchestrates a report run: generation cells across providers, then
 * extraction cells over completed generations. Pure of file I/O — the caller
 * supplies the already-loaded cell set and an append callback (cli.ts owns
 * results.jsonl).
 *
 *   task list = prompts × providers × samples
 *        │  skip cellIds already present (resume — amendment 2)
 *        ▼
 *   p-limit(per provider) ──► adapters (callWithRetry inside)
 *        │  append each cell the moment it completes
 *        ▼
 *   outage check (provider < 50% ok → hold)
 *        ▼
 *   extraction pass (plain cheap-model completion per ok generation cell)
 */
import pLimit from "p-limit";
import type {
  Adapter,
  Cell,
  ExtractionCell,
  GenerationCell,
  Provider,
  RunConfig,
} from "./types.js";
import { PROVIDER_OUTAGE_THRESHOLD } from "./types.js";
import { extractionCellId, generationCellId } from "./shared/cellId.js";
import { callWithRetry, HttpError } from "./shared/callWithRetry.js";
import { buildExtractionPrompt, EXTRACTION_PROMPT_VERSION, parseExtractionResponse } from "./extract.js";

export const GROUNDING_CONFIG = "web_search:on";
export const PER_PROVIDER_CONCURRENCY = 3;
export const EXTRACTOR_MODEL = "claude-haiku-4-5-20251001";

export interface RunProgress {
  done: number;
  total: number;
  failed: number;
}

export interface GenerationOutcome {
  /** Providers whose ok-fraction fell below PROVIDER_OUTAGE_THRESHOLD. */
  outageProviders: Provider[];
  progress: RunProgress;
}

/** Enabled providers = keys of config.models (the model-selection parameter). */
export function enabledProviders(config: RunConfig): Provider[] {
  return (Object.keys(config.models) as Provider[]).filter(
    (p) => config.models[p] !== undefined,
  );
}

export async function runGeneration(args: {
  config: RunConfig;
  adapters: Partial<Record<Provider, Adapter>>;
  /** cellIds of already-completed OK cells (failed cells are always retried). */
  existingCellIds: Set<string>;
  /** Prior ok-cell counts per provider, so a resumed run isn't misread as an outage. */
  existingOkByProvider?: Partial<Record<Provider, number>>;
  append: (cell: GenerationCell) => void;
  onProgress?: (p: RunProgress) => void;
}): Promise<GenerationOutcome> {
  const { config, adapters, existingCellIds, append, onProgress } = args;
  const providers = enabledProviders(config);
  for (const p of providers) {
    if (!adapters[p]) throw new Error(`config enables provider "${p}" but no adapter/key was supplied`);
  }
  const limits = new Map(providers.map((p) => [p, pLimit(PER_PROVIDER_CONCURRENCY)]));

  interface Task {
    provider: Provider;
    cellId: string;
    promptId: string;
    promptText: string;
    sampleIndex: number;
  }

  const tasks: Task[] = [];
  for (const provider of providers) {
    const model = config.models[provider]!;
    for (const prompt of config.promptSet.prompts) {
      for (let s = 0; s < config.samplesPerPrompt; s++) {
        const cellId = generationCellId({
          promptText: prompt.text,
          provider,
          model,
          groundingConfig: GROUNDING_CONFIG,
          sampleIndex: s,
        });
        if (existingCellIds.has(cellId)) continue;
        tasks.push({ provider, cellId, promptId: prompt.id, promptText: prompt.text, sampleIndex: s });
      }
    }
  }

  const progress: RunProgress = { done: 0, total: tasks.length, failed: 0 };
  // Tally per provider over ALL planned cells this run (existing ok cells
  // count toward health so a resumed run isn't misread as an outage).
  const okByProvider = new Map(providers.map((p) => [p, 0]));
  const plannedPerProvider = config.promptSet.prompts.length * config.samplesPerPrompt;

  await Promise.all(
    tasks.map((t) =>
      limits.get(t.provider)!(async () => {
        const model = config.models[t.provider]!;
        const base = {
          kind: "generation" as const,
          cellId: t.cellId,
          promptId: t.promptId,
          promptText: t.promptText,
          provider: t.provider,
          model,
          groundingConfig: GROUNDING_CONFIG,
          sampleIndex: t.sampleIndex,
          timestamp: new Date().toISOString(),
        };
        try {
          const res = await adapters[t.provider]!({ promptText: t.promptText, model });
          okByProvider.set(t.provider, (okByProvider.get(t.provider) ?? 0) + 1);
          append({ ...base, status: "ok", responseText: res.responseText, citations: res.citations });
        } catch (err) {
          progress.failed++;
          append({ ...base, status: "failed", error: err instanceof Error ? err.message : String(err) });
        } finally {
          progress.done++;
          onProgress?.(progress);
        }
      }),
    ),
  );

  const outageProviders = providers.filter((p) => {
    const priorOk = args.existingOkByProvider?.[p] ?? 0;
    const okFraction = ((okByProvider.get(p) ?? 0) + priorOk) / Math.max(plannedPerProvider, 1);
    return okFraction < PROVIDER_OUTAGE_THRESHOLD;
  });
  return { outageProviders, progress };
}

export async function runExtraction(args: {
  cells: Cell[];
  /** Client identity — drives the category-aware extraction prompt. */
  client: Pick<import("./types.js").BrandConfig, "name" | "industry">;
  anthropicApiKey: string;
  append: (cell: ExtractionCell) => void;
  onProgress?: (p: RunProgress) => void;
  extractorModel?: string;
  fetchImpl?: typeof fetch;
}): Promise<RunProgress> {
  const { cells, client, anthropicApiKey, append, onProgress } = args;
  const extractorModel = args.extractorModel ?? EXTRACTOR_MODEL;
  const fetchImpl = args.fetchImpl ?? fetch;
  const extractorPromptVersion = EXTRACTION_PROMPT_VERSION;

  const existingExtractions = new Set(
    cells.filter((c): c is ExtractionCell => c.kind === "extraction").map((c) => c.cellId),
  );
  const targets = cells.filter(
    (c): c is GenerationCell =>
      c.kind === "generation" &&
      c.status === "ok" &&
      !existingExtractions.has(
        extractionCellId({ generationCellId: c.cellId, extractorModel, extractorPromptVersion }),
      ),
  );

  const limit = pLimit(PER_PROVIDER_CONCURRENCY);
  const progress: RunProgress = { done: 0, total: targets.length, failed: 0 };

  await Promise.all(
    targets.map((gen) =>
      limit(async () => {
        const cellId = extractionCellId({ generationCellId: gen.cellId, extractorModel, extractorPromptVersion });
        const base = {
          kind: "extraction" as const,
          cellId,
          generationCellId: gen.cellId,
          extractorModel,
          timestamp: new Date().toISOString(),
        };
        try {
          const raw = await callWithRetry(() =>
            plainAnthropicCompletion(fetchImpl, anthropicApiKey, extractorModel, buildExtractionPrompt(gen.responseText ?? "", client)),
          );
          append({ ...base, status: "ok", brands: parseExtractionResponse(raw) });
        } catch (err) {
          progress.failed++;
          append({ ...base, status: "failed", error: err instanceof Error ? err.message : String(err) });
        } finally {
          progress.done++;
          onProgress?.(progress);
        }
      }),
    ),
  );
  return progress;
}

/** Ungrounded cheap completion for extraction — deliberately NOT the grounded adapter. */
async function plainAnthropicCompletion(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 512, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  if (!text) throw new Error("empty extraction response");
  return text;
}
