/**
 * Shared "current cell set" filter (eng review DRY).
 *
 * results.jsonl is append-only, so it accumulates cells for prompts since
 * removed from the config and providers since disabled. Every consumer that
 * reports on the CURRENT config — the render pipeline and the insights page —
 * must compute over the SAME set: enabled-provider generation cells whose
 * promptText is still in the prompt set, plus the extraction cells that join to
 * a kept generation cell. This is the exact filter renderPipeline.ts used
 * inline; it lives here so the report and insights never fork the logic.
 */
import { enabledProviders } from "./runner.js";
import type { Cell, RunConfig } from "./types.js";

/**
 * The cells the CURRENT config would render. Generation cells survive when
 * their provider is enabled and their promptText is still in the prompt set;
 * extraction cells survive when they join to a surviving generation cell.
 * Orphaned cells (removed prompts, disabled providers) are dropped.
 */
export function filterToCurrentCells(cells: Cell[], config: RunConfig): Cell[] {
  const enabledSet = new Set(enabledProviders(config));
  const currentPromptTexts = new Set(config.promptSet.prompts.map((p) => p.text));
  const keptGenIds = new Set(
    cells
      .filter(
        (c) =>
          c.kind === "generation" &&
          enabledSet.has(c.provider) &&
          currentPromptTexts.has(c.promptText),
      )
      .map((c) => c.cellId),
  );
  return cells.filter((c) =>
    c.kind === "generation"
      ? enabledSet.has(c.provider) && currentPromptTexts.has(c.promptText)
      : keptGenIds.has(c.generationCellId),
  );
}
