/**
 * Resume-aware run scope (design decision 4: cost estimate before every run).
 * This computes only the CALL COUNTS — total planned vs. new (not-yet-ok) — so
 * it stays under the root tsconfig and is unit-testable. The route multiplies
 * these by the per-call price constants in app/lib/pricing.ts to get USD.
 */
import { generationCellId } from "../core/shared/cellId.js";
import { enabledProviders, GROUNDING_CONFIG } from "../core/runner.js";
import type { Cell, Provider, RunConfig } from "../core/types.js";

export interface CallEstimate {
  /** prompts × enabled providers × samples — the full planned run. */
  totalCalls: number;
  /** Planned cells NOT already ok on disk — the marginal (resume) run. */
  newCalls: number;
  /** New-call breakdown per enabled provider (for per-provider pricing). */
  newByProvider: Partial<Record<Provider, number>>;
}

export function estimateCalls(config: RunConfig, cells: Cell[]): CallEstimate {
  const providers = enabledProviders(config);
  const okIds = new Set(
    cells
      .filter((c) => c.kind === "generation" && c.status === "ok")
      .map((c) => c.cellId),
  );

  let totalCalls = 0;
  let newCalls = 0;
  const newByProvider: Partial<Record<Provider, number>> = {};

  for (const provider of providers) {
    const model = config.models[provider]!;
    let providerNew = 0;
    for (const prompt of config.promptSet.prompts) {
      for (let s = 0; s < config.samplesPerPrompt; s++) {
        totalCalls++;
        const id = generationCellId({
          promptText: prompt.text,
          provider,
          model,
          groundingConfig: GROUNDING_CONFIG,
          sampleIndex: s,
        });
        if (!okIds.has(id)) {
          newCalls++;
          providerNew++;
        }
      }
    }
    newByProvider[provider] = providerNew;
  }

  return { totalCalls, newCalls, newByProvider };
}
