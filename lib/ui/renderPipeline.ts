/**
 * Render pipeline — the core of cli.ts's `render` command, extracted so the CLI
 * and the cockpit's POST /api/render share ONE implementation. Given a config,
 * the loaded cells, and the prior trend, it runs the outage guard, filters to
 * enabled-provider cells, aggregates, renders, and merges the trend.
 *
 * The outage guard is a founder decision (design doc report-level failure
 * policy): rendering refuses when a provider is below the completion threshold
 * unless the caller acknowledges it.
 */
import { aggregate } from "../aggregate.js";
import { renderReport } from "../render.js";
import { enabledProviders } from "../runner.js";
import { PROVIDER_OUTAGE_THRESHOLD } from "../types.js";
import type { Cell, Provider, RunConfig, TrendPoint } from "../types.js";

/**
 * Enabled providers below the completion threshold. `planned` is
 * prompts × samples (per provider); only enabled providers are checked, so
 * cells from providers since removed from the config are ignored.
 */
export function computeOutageProviders(cells: Cell[], config: RunConfig): Provider[] {
  const planned = config.promptSet.prompts.length * config.samplesPerPrompt;
  const okCount = new Map<Provider, number>();
  for (const c of cells) {
    if (c.kind === "generation" && c.status === "ok") {
      okCount.set(c.provider, (okCount.get(c.provider) ?? 0) + 1);
    }
  }
  return enabledProviders(config).filter(
    (p) => (okCount.get(p) ?? 0) / Math.max(planned, 1) < PROVIDER_OUTAGE_THRESHOLD,
  );
}

export interface RenderSuccess {
  html: string;
  /** Prior trend merged with the current run's points, deduped by (date, version). */
  trend: TrendPoint[];
  /** Providers below threshold (non-empty only when the caller acknowledged). */
  outageProviders: Provider[];
}

export interface RenderOutage {
  outage: true;
  outageProviders: Provider[];
}

export type RenderResult = RenderSuccess | RenderOutage;

export function isOutage(result: RenderResult): result is RenderOutage {
  return "outage" in result;
}

export function renderFromResults(args: {
  config: RunConfig;
  cells: Cell[];
  priorTrend: TrendPoint[];
  acknowledgeOutage?: boolean;
}): RenderResult {
  const { config, cells, priorTrend } = args;

  const outageProviders = computeOutageProviders(cells, config);
  if (outageProviders.length > 0 && !args.acknowledgeOutage) {
    return { outage: true, outageProviders };
  }

  // Only same-prompt-set-version points are comparable, and a prior point for
  // the CURRENT period is dropped so a re-render replaces it (no flat trend).
  const comparableTrend = priorTrend.filter(
    (t) => t.promptSetVersion === config.promptSet.version && t.date !== config.dateRange.to,
  );

  // Aggregate over enabled providers' cells only, plus extraction cells that
  // join to a kept generation cell.
  const enabledSet = new Set(enabledProviders(config));
  const keptGenIds = new Set(
    cells.filter((c) => c.kind === "generation" && enabledSet.has(c.provider)).map((c) => c.cellId),
  );
  const relevantCells = cells.filter((c) =>
    c.kind === "generation" ? enabledSet.has(c.provider) : keptGenIds.has(c.generationCellId),
  );

  const agg = aggregate(relevantCells, config, comparableTrend);
  const html = renderReport(agg, config);

  // Persist trend, deduped by (date, version) so re-renders are idempotent.
  const merged = [...priorTrend];
  for (const pt of agg.trend) {
    if (!merged.some((m) => m.date === pt.date && m.promptSetVersion === pt.promptSetVersion)) {
      merged.push(pt);
    }
  }

  return { html, trend: merged, outageProviders };
}
