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
import { aggregate } from "../core/aggregate.js";
import { filterToCurrentCells } from "../core/cellFilter.js";
import { renderReport } from "../core/render.js";
import { enabledProviders } from "../core/runner.js";
import { PROVIDER_OUTAGE_THRESHOLD } from "../core/types.js";
import type { Cell, Provider, RunConfig, TrendPoint } from "../core/types.js";

/**
 * Per enabled-provider completion against the CURRENT prompt set. `completed`
 * counts ok generation cells whose promptText is still in config.promptSet
 * (orphaned cells from prompts since removed from the config are ignored, so
 * the count reflects the report the founder is about to render). `planned` is
 * prompts × samples per provider.
 */
export function providerCompletion(
  cells: Cell[],
  config: RunConfig,
): Array<{ provider: Provider; completed: number; planned: number }> {
  const planned = config.promptSet.prompts.length * config.samplesPerPrompt;
  const currentPromptTexts = new Set(config.promptSet.prompts.map((p) => p.text));
  const okCount = new Map<Provider, number>();
  for (const c of cells) {
    if (c.kind === "generation" && c.status === "ok" && currentPromptTexts.has(c.promptText)) {
      okCount.set(c.provider, (okCount.get(c.provider) ?? 0) + 1);
    }
  }
  return enabledProviders(config).map((provider) => ({
    provider,
    completed: okCount.get(provider) ?? 0,
    planned,
  }));
}

/**
 * Enabled providers below the completion threshold. Only enabled providers are
 * checked (cells from removed providers are ignored) and only current-prompt-set
 * cells count toward completion (orphaned cells from removed prompts are ignored).
 */
export function computeOutageProviders(cells: Cell[], config: RunConfig): Provider[] {
  return providerCompletion(cells, config)
    .filter((c) => c.completed / Math.max(c.planned, 1) < PROVIDER_OUTAGE_THRESHOLD)
    .map((c) => c.provider);
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

  // Aggregate over enabled providers' CURRENT-prompt-set generation cells only,
  // plus extraction cells that join to a kept generation cell. Cells for prompts
  // since removed from the config are orphans in the append-only results file and
  // must not pollute the counts. The insights page shares this exact filter.
  const relevantCells = filterToCurrentCells(cells, config);

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
