/**
 * Insights service — loads a config + its results from disk and computes the
 * insights, restricting the append-only cell log to the CURRENT config's cell
 * set with the SAME filter the render pipeline uses (filterToCurrentCells), so
 * the insights page and the rendered report never disagree about which cells
 * count. The pure analytics live in backend/core/insights.ts; this layer only
 * does the I/O and the shared filtering.
 */
import { filterToCurrentCells } from "../core/cellFilter.js";
import { computeInsights } from "../core/insights.js";
import type { InsightsResult } from "../core/insights.js";
import type { RunConfig } from "../core/types.js";
import { loadCells } from "./cells.js";

export type { InsightsResult } from "../core/insights.js";

/**
 * Compute insights for an already-loaded config over the cells at `resultsPath`.
 * Orphaned cells (removed prompts, disabled providers) are dropped before the
 * pure compute, identically to the render pipeline.
 */
export function insightsFromResults(config: RunConfig, resultsFilePath: string): InsightsResult {
  const cells = filterToCurrentCells(loadCells(resultsFilePath), config);
  return computeInsights(cells, config);
}
