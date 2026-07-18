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
  BrandConfig,
  Cell,
  CitationGapRow,
  ExtractionCell,
  GenerationCell,
  ModelStats,
  PromptBreakdownRow,
  Provider,
  PullQuote,
  RunConfig,
  ShareOfVoiceSummary,
  SourceLeaderboard,
  SourceLeaderboardRow,
  TrendPoint,
} from "./types.js";
import { MIN_SAMPLES_PER_CELL } from "./types.js";
import { dedupeExtractions, detectMention, tallyCompetitors } from "./extract.js";

const MAX_GAP_ROWS = 10;
const MAX_SOURCE_ROWS = 8;

/**
 * Deterministically extract the sentence containing the brand's first mention
 * within `text`, or undefined if the brand is not named. Response prose is
 * markdown, so we split on newlines AND sentence terminators, then strip
 * markdown emphasis/heading markers for a clean, quotable line. Detection runs
 * on the raw segment via detectMention (word-boundary alias match), so the
 * asterisks around "**Socially Powerful**" never break the match.
 */
function firstMentionSentence(text: string, brand: BrandConfig): string | undefined {
  const segments = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/));
  for (const segment of segments) {
    if (!detectMention(segment, brand)) continue;
    const clean = segment
      .replace(/[*#`>_~]/g, "") // strip markdown emphasis/heading/quote markers
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length > 0) return clean;
  }
  return undefined;
}

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

  // Competitor tally (client row + top non-client), sorted descending by
  // mentions. Computed once; reused by the pull-quote fallback and the output.
  const competitors = tallyCompetitors(
    genCells,
    extractions,
    config.client,
    config.competitors,
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

  // ---- (R4.1) Overall share of voice ----
  // Derived HERE over the sufficiency-respecting completed cells (NOT via
  // computeInsights, which includes all ok cells) so the hero line can never
  // disagree with the stat cards. clientMentions equals Σ per-model mentionRuns.
  let sovClientMentions = 0;
  let sovCompetitorMentions = 0;
  for (const cell of allCompleted) {
    const text = cell.responseText ?? "";
    if (detectMention(text, config.client)) sovClientMentions++;
    for (const comp of config.competitors) {
      if (detectMention(text, comp)) sovCompetitorMentions++;
    }
  }
  const sovTotal = sovClientMentions + sovCompetitorMentions;
  const shareOfVoice: ShareOfVoiceSummary = {
    clientMentions: sovClientMentions,
    totalMentions: sovTotal,
    // Guard zero denominator: no brand named anywhere → 0, never NaN.
    share: sovTotal === 0 ? 0 : sovClientMentions / sovTotal,
  };

  // ---- (R4.2) Source leaderboard — "% of runs", counted UNIQUELY per run ----
  // A run citing a domain twice counts ONCE (distinct from R1's occurrence
  // tally), so runsCiting / completedRuns is an honest fraction of runs.
  const runsCiting = new Map<string, number>();
  for (const cell of allCompleted) {
    const seenInRun = new Set<string>();
    for (const ci of cell.citations ?? []) {
      const domain = normalizeDomain(ci.domain);
      if (domain.length === 0) continue;
      seenInRun.add(domain);
    }
    for (const domain of seenInRun) {
      runsCiting.set(domain, (runsCiting.get(domain) ?? 0) + 1);
    }
  }
  const sourceRows: SourceLeaderboardRow[] = [...runsCiting.entries()]
    .map(([domain, count]) => ({
      domain,
      runsCiting: count,
      clientCited: domain === clientDomain,
    }))
    // Descending by runs, then domain ascending for a stable, deterministic order.
    .sort((a, b) => b.runsCiting - a.runsCiting || a.domain.localeCompare(b.domain))
    .slice(0, MAX_SOURCE_ROWS);
  const sources: SourceLeaderboard = {
    completedRuns: allCompleted.length,
    rows: sourceRows,
  };

  // ---- (R4.3) Pull-quote — client's first mention, else top competitor's ----
  // Deterministic: allCompleted is in stable (provider × group-insertion) order.
  let pullQuote: PullQuote | undefined;
  for (const cell of allCompleted) {
    const sentence = firstMentionSentence(cell.responseText ?? "", config.client);
    if (sentence !== undefined) {
      pullQuote = { text: sentence, provider: cell.provider, brand: config.client.name, isClient: true };
      break;
    }
  }
  if (pullQuote === undefined) {
    // Zero-mention fallback: the top competitor by prose mentions (competitors
    // is already sorted descending; skip the always-present client row).
    const topCompetitorName = competitors.find((c) => !c.isClient && c.mentions > 0)?.name;
    const topCompetitor = topCompetitorName
      ? config.competitors.find((c) => c.name === topCompetitorName)
      : undefined;
    if (topCompetitor) {
      for (const cell of allCompleted) {
        const sentence = firstMentionSentence(cell.responseText ?? "", topCompetitor);
        if (sentence !== undefined) {
          pullQuote = { text: sentence, provider: cell.provider, brand: topCompetitor.name, isClient: false };
          break;
        }
      }
    }
  }

  // ---- (R4.4) Per-prompt appendix: prompt × per-provider client mentions ----
  interface PromptAccum {
    byProvider: Map<Provider, { samples: number; mentioned: number }>;
  }
  const promptAccum = new Map<string, PromptAccum>();
  for (const cell of allCompleted) {
    let acc = promptAccum.get(cell.promptText);
    if (acc === undefined) {
      acc = { byProvider: new Map() };
      promptAccum.set(cell.promptText, acc);
    }
    let cnt = acc.byProvider.get(cell.provider);
    if (cnt === undefined) {
      cnt = { samples: 0, mentioned: 0 };
      acc.byProvider.set(cell.provider, cnt);
    }
    cnt.samples++;
    if (detectMention(cell.responseText ?? "", config.client)) cnt.mentioned++;
  }
  // Stable ordering: prompts in config order, then providers in config order.
  const promptBreakdown: PromptBreakdownRow[] = config.promptSet.prompts
    .map((p) => p.text)
    .filter((text) => promptAccum.has(text))
    .map((text) => {
      const acc = promptAccum.get(text)!;
      return {
        promptText: text,
        cells: providers
          .filter((provider) => acc.byProvider.has(provider))
          .map((provider) => {
            const cnt = acc.byProvider.get(provider)!;
            return { provider, samples: cnt.samples, mentioned: cnt.mentioned };
          }),
      };
    });

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
    competitors,
    citationGaps,
    trend: [...priorTrend, currentPoint],
    promptSetVersion: config.promptSet.version,
    totalPlanned: plannedPerProvider * providers.length,
    totalCompleted,
    generatedAt: new Date().toISOString(),
    shareOfVoice,
    sources,
    pullQuote,
    promptBreakdown,
  };
}
