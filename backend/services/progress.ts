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
 *
 * R7 adds a per-provider generation breakdown (`byProvider`) and a
 * `deriveFailures` helper — both computed over the SAME reconstructed plan, so a
 * per-provider bar and the failures list can never disagree with the totals.
 */
import { generationCellId } from "../core/shared/cellId.js";
import { enabledProviders, GROUNDING_CONFIG } from "../core/runner.js";
import type { Cell, ExtractionCell, GenerationCell, Provider, RunConfig } from "../core/types.js";

export interface PhaseProgress {
  done: number;
  total: number;
  failed: number;
}

/** Per-provider slice of the generation phase (R7). */
export interface ProviderProgress {
  provider: string;
  done: number;
  total: number;
  failed: number;
}

export interface DerivedProgress {
  generation: PhaseProgress;
  extraction: PhaseProgress;
  /** Per-enabled-provider generation tallies, in enabled-provider order (R7). */
  byProvider: ProviderProgress[];
}

/** One latest-wins failed generation cell for the current plan (R7). */
export interface FailedGeneration {
  promptId: string;
  provider: string;
  sampleIndex: number;
  /** The stored adapter error string ("" when a failed cell has none). */
  error: string;
  timestamp: string;
}

/**
 * The planned generation cell IDs for the current config (prompts × enabled
 * providers × samples), mapped to their provider. Reconstructed with the SAME
 * content-hash IDs the runner uses so "done"/"failed" count exactly the planned
 * cells that landed — never stale cells from removed providers or edited prompts.
 */
function plannedGenerations(config: RunConfig): Map<string, Provider> {
  const providerOf = new Map<string, Provider>();
  for (const provider of enabledProviders(config)) {
    const model = config.models[provider]!;
    for (const prompt of config.promptSet.prompts) {
      for (let s = 0; s < config.samplesPerPrompt; s++) {
        providerOf.set(
          generationCellId({
            promptText: prompt.text,
            provider,
            model,
            groundingConfig: GROUNDING_CONFIG,
            sampleIndex: s,
          }),
          provider,
        );
      }
    }
  }
  return providerOf;
}

/**
 * Latest cell per planned generation ID (append-only file: a retried cell
 * appends a new record with the same content-hash ID; the last wins). Only
 * planned IDs are kept, so orphans from removed prompts/providers never count.
 */
function latestPlannedGenerations(
  cells: Cell[],
  plannedIds: Set<string>,
): Map<string, GenerationCell> {
  const latest = new Map<string, GenerationCell>();
  for (const c of cells) {
    if (c.kind !== "generation" || !plannedIds.has(c.cellId)) continue;
    const prev = latest.get(c.cellId);
    if (prev === undefined || c.timestamp >= prev.timestamp) latest.set(c.cellId, c);
  }
  return latest;
}

export function deriveProgress(cells: Cell[], config: RunConfig): DerivedProgress {
  const providers = enabledProviders(config);
  const providerOf = plannedGenerations(config);
  const plannedIds = new Set(providerOf.keys());

  const genLatest = latestPlannedGenerations(cells, plannedIds);

  // Per-provider tallies, seeded in enabled-provider order so a provider with
  // zero landed cells still streams a (0 / total) bar rather than vanishing.
  const byProviderMap = new Map<string, ProviderProgress>();
  for (const p of providers) byProviderMap.set(p, { provider: p, done: 0, total: 0, failed: 0 });
  for (const [, provider] of providerOf) byProviderMap.get(provider)!.total++;

  let genDone = 0;
  let genFailed = 0;
  const okGenIds = new Set<string>();
  for (const id of plannedIds) {
    const c = genLatest.get(id);
    if (c === undefined) continue;
    genDone++;
    const pp = byProviderMap.get(providerOf.get(id)!)!;
    pp.done++;
    if (c.status === "failed") {
      genFailed++;
      pp.failed++;
    } else {
      okGenIds.add(id);
    }
  }
  const generation: PhaseProgress = { done: genDone, total: plannedIds.size, failed: genFailed };
  const byProvider = providers.map((p) => byProviderMap.get(p)!);

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

  return { generation, extraction, byProvider };
}

/**
 * Latest-wins failed generation cells for the CURRENT plan. Because we keep only
 * the newest cell per planned ID, a cell that failed and was later retried
 * successfully is represented by its ok retry and NOT listed here. Sorted by
 * provider then sample index for a stable UI order.
 */
export function deriveFailures(cells: Cell[], config: RunConfig): FailedGeneration[] {
  const providerOf = plannedGenerations(config);
  const plannedIds = new Set(providerOf.keys());
  const genLatest = latestPlannedGenerations(cells, plannedIds);

  const failures: FailedGeneration[] = [];
  for (const c of genLatest.values()) {
    if (c.status !== "failed") continue;
    failures.push({
      promptId: c.promptId,
      provider: c.provider,
      sampleIndex: c.sampleIndex,
      error: c.error ?? "",
      timestamp: c.timestamp,
    });
  }
  failures.sort((a, b) =>
    a.provider === b.provider
      ? a.sampleIndex - b.sampleIndex
      : a.provider.localeCompare(b.provider),
  );
  return failures;
}
