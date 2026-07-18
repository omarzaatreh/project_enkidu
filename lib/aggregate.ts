/**
 * Aggregation with honest denominators (eng review amendments).
 *
 * Generation cells group by (promptText × provider). A group with fewer
 * than MIN_SAMPLES_PER_CELL ok-samples is INSUFFICIENT: it is excluded
 * entirely from that provider's denominators and counted in that
 * provider's insufficientPrompts.
 *
 * mentionRuns (client named in prose) and citedRuns (client domain in
 * citation metadata) are INDEPENDENT labeled figures. They are never
 * summed — a cell can count in both, either, or neither.
 */

import type {
  AggregateResult,
  Cell,
  CitationGapRow,
  ExtractionCell,
  GenerationCell,
  ModelStats,
  Provider,
  RunConfig,
  TrendPoint,
} from "./types.js";
import { MIN_SAMPLES_PER_CELL } from "./types.js";
import { dedupeExtractions, detectMention, tallyCompetitors } from "./extract.js";

const MAX_GAP_ROWS = 10;

/** Lowercase and strip a leading "www." for domain equality checks. */
function normalizeDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

export function aggregate(
  cells: Cell[],
  config: RunConfig,
  priorTrend: TrendPoint[],
): AggregateResult {
  const genCells = cells.filter((c): c is GenerationCell => c.kind === "generation");
  // Latest-wins: superseded extraction cells (older prompt/model versions)
  // remain in the append-only results file and must not double-count.
  const extractions = dedupeExtractions(
    cells.filter((c): c is ExtractionCell => c.kind === "extraction"),
  );

  const providers = Object.keys(config.models) as Provider[];
  const plannedPerProvider =
    config.promptSet.prompts.length * config.samplesPerPrompt;
  const clientDomain = normalizeDomain(config.client.domain);

  // ---- Group by (promptText × provider); split sufficient/insufficient ----
  const groups = new Map<string, GenerationCell[]>();
  for (const cell of genCells) {
    const key = `${cell.provider}\u0000${cell.promptText}`;
    const list = groups.get(key);
    if (list) list.push(cell);
    else groups.set(key, [cell]);
  }

  /** ok cells belonging to sufficient groups, per provider. */
  const completedByProvider = new Map<Provider, GenerationCell[]>();
  const insufficientByProvider = new Map<Provider, number>();
  for (const provider of providers) {
    completedByProvider.set(provider, []);
    insufficientByProvider.set(provider, 0);
  }

  for (const groupCells of groups.values()) {
    const first = groupCells[0];
    if (first === undefined) continue;
    const provider = first.provider;
    const ok = groupCells.filter((c) => c.status === "ok");
    if (ok.length < MIN_SAMPLES_PER_CELL) {
      insufficientByProvider.set(
        provider,
        (insufficientByProvider.get(provider) ?? 0) + 1,
      );
    } else {
      const list = completedByProvider.get(provider);
      if (list) list.push(...ok);
      else completedByProvider.set(provider, [...ok]);
    }
  }

  // ---- Per-model stats ----
  const perModel: ModelStats[] = providers.map((provider) => {
    const completed = completedByProvider.get(provider) ?? [];
    let mentionRuns = 0;
    let citedRuns = 0;
    for (const cell of completed) {
      // Independent figures: prose mention and citation presence are
      // evaluated separately; a cell may increment both, either, or neither.
      if (detectMention(cell.responseText ?? "", config.client)) mentionRuns++;
      const cited = (cell.citations ?? []).some(
        (ci) => normalizeDomain(ci.domain) === clientDomain,
      );
      if (cited) citedRuns++;
    }
    return {
      provider,
      model: config.models[provider] ?? "unknown",
      completedRuns: completed.length,
      plannedRuns: plannedPerProvider,
      mentionRuns,
      citedRuns,
      insufficientPrompts: insufficientByProvider.get(provider) ?? 0,
    };
  });

  const allCompleted: GenerationCell[] = providers.flatMap(
    (p) => completedByProvider.get(p) ?? [],
  );

  // ---- Citation gap table ----
  // Domains cited in ≥1 completed cell where the CLIENT was mentioned (prose).
  const clientCitedDomains = new Set<string>();
  for (const cell of allCompleted) {
    if (!detectMention(cell.responseText ?? "", config.client)) continue;
    for (const ci of cell.citations ?? []) {
      clientCitedDomains.add(normalizeDomain(ci.domain));
    }
  }

  interface GapAccum {
    domain: string;
    exampleTitle?: string;
    competitors: Set<string>;
  }
  const gapMap = new Map<string, GapAccum>();
  for (const cell of allCompleted) {
    const text = cell.responseText ?? "";
    const mentioned = config.competitors.filter((comp) => detectMention(text, comp));
    if (mentioned.length === 0) continue;
    for (const ci of cell.citations ?? []) {
      const domain = normalizeDomain(ci.domain);
      let row = gapMap.get(domain);
      if (row === undefined) {
        row = { domain, competitors: new Set<string>() };
        gapMap.set(domain, row);
      }
      if (row.exampleTitle === undefined && ci.title !== undefined) {
        row.exampleTitle = ci.title;
      }
      for (const comp of mentioned) row.competitors.add(comp.name);
    }
  }
  const citationGaps: CitationGapRow[] = [...gapMap.values()]
    .map((row) => ({
      domain: row.domain,
      exampleTitle: row.exampleTitle,
      competitorsCited: [...row.competitors],
      clientCited: clientCitedDomains.has(row.domain),
    }))
    .sort(
      (a, b) =>
        Number(a.clientCited) - Number(b.clientCited) ||
        b.competitorsCited.length - a.competitorsCited.length,
    )
    .slice(0, MAX_GAP_ROWS);

  // ---- Trend ----
  const totalCompleted = perModel.reduce((sum, m) => sum + m.completedRuns, 0);
  const totalMentions = perModel.reduce((sum, m) => sum + m.mentionRuns, 0);
  const currentPoint: TrendPoint = {
    date: config.dateRange.to,
    promptSetVersion: config.promptSet.version,
    overallMentionRate: totalCompleted === 0 ? 0 : totalMentions / totalCompleted,
  };

  return {
    client: config.client,
    perModel,
    competitors: tallyCompetitors(genCells, extractions, config.client, config.competitors),
    citationGaps,
    trend: [...priorTrend, currentPoint],
    promptSetVersion: config.promptSet.version,
    totalPlanned: plannedPerProvider * providers.length,
    totalCompleted,
    generatedAt: new Date().toISOString(),
  };
}
