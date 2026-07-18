/**
 * Progress derivation from disk (design decision 2: progress is derived from
 * results.jsonl, not memory). Recompute done/total/failed purely from the
 * loaded cells + config, so a closed tab or a restarted server loses nothing
 * and a resumed/partial run reports correctly.
 *
 * Planned generation cells are reconstructed with the SAME content-hash IDs the
 * runner uses, so "done" counts exactly the planned cells that have landed —
 * never stale cells from removed providers or edited prompts. Extraction total
 * follows the ok generations (the runner's extraction targets), using
 * latest-wins dedupe per generation cell.
 */
import { generationCellId } from "../core/shared/cellId.js";
import { enabledProviders, GROUNDING_CONFIG } from "../core/runner.js";
import type { Cell, ExtractionCell, GenerationCell, RunConfig } from "../core/types.js";

export interface PhaseProgress {
  done: number;
  total: number;
  failed: number;
}

export interface DerivedProgress {
  generation: PhaseProgress;
  extraction: PhaseProgress;
}

export function deriveProgress(cells: Cell[], config: RunConfig): DerivedProgress {
  const providers = enabledProviders(config);

  // Planned generation cell IDs (prompts × enabled providers × samples).
  const plannedIds = new Set<string>();
  for (const provider of providers) {
    const model = config.models[provider]!;
    for (const prompt of config.promptSet.prompts) {
      for (let s = 0; s < config.samplesPerPrompt; s++) {
        plannedIds.add(
          generationCellId({
            promptText: prompt.text,
            provider,
            model,
            groundingConfig: GROUNDING_CONFIG,
            sampleIndex: s,
          }),
        );
      }
    }
  }

  // Latest cell per planned generation ID (append-only file: a retried cell
  // appends a new record with the same content-hash ID; the last wins).
  const genLatest = new Map<string, GenerationCell>();
  for (const c of cells) {
    if (c.kind !== "generation" || !plannedIds.has(c.cellId)) continue;
    const prev = genLatest.get(c.cellId);
    if (prev === undefined || c.timestamp >= prev.timestamp) genLatest.set(c.cellId, c);
  }

  let genDone = 0;
  let genFailed = 0;
  const okGenIds = new Set<string>();
  for (const id of plannedIds) {
    const c = genLatest.get(id);
    if (c === undefined) continue;
    genDone++;
    if (c.status === "failed") genFailed++;
    else okGenIds.add(id);
  }
  const generation: PhaseProgress = { done: genDone, total: plannedIds.size, failed: genFailed };

  // Extraction targets = ok generations. Latest extraction per generation cell.
  const extLatest = new Map<string, ExtractionCell>();
  for (const c of cells) {
    if (c.kind !== "extraction" || !okGenIds.has(c.generationCellId)) continue;
    const prev = extLatest.get(c.generationCellId);
    if (prev === undefined || c.timestamp >= prev.timestamp) extLatest.set(c.generationCellId, c);
  }

  let extDone = 0;
  let extFailed = 0;
  for (const id of okGenIds) {
    const c = extLatest.get(id);
    if (c === undefined) continue;
    extDone++;
    if (c.status === "failed") extFailed++;
  }
  const extraction: PhaseProgress = { done: extDone, total: okGenIds.size, failed: extFailed };

  return { generation, extraction };
}
