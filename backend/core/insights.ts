/**
 * Insights — the analytics the report currently throws away, computed as a
 * single pure function over generation cells. This is the foundation the
 * insights page, prompt chips, and a richer report will consume.
 *
 * PURE and deterministic: imports only from core, no I/O, no clock except the
 * generatedAt stamp the caller may ignore. It computes over the cells it is
 * given — the caller (backend/services/insights.ts) first filters the
 * append-only results to the CURRENT config's cell set via
 * cellFilter.filterToCurrentCells, the SAME filter the render pipeline uses, so
 * insights and the report never disagree about which cells count.
 *
 * Every figure comes from EXISTING stored fields:
 *   - prose mentions via detectMention (word-boundary alias match)
 *   - citation domains via citations[].domain
 * Nothing here needs a new LLM call. Sentiment/positioning is deliberately OUT
 * — it is not computable from stored fields.
 *
 * Group semantics mirror aggregate.ts: cells group by (promptText × provider),
 * and only ok generation cells count.
 */

import type {
  BrandConfig,
  Cell,
  GenerationCell,
  Provider,
  RunConfig,
} from "./types.js";
import { detectMention } from "./extract.js";

/** Lowercase and strip a leading "www." for domain equality checks (mirrors aggregate.ts). */
function normalizeDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

// ---------- Result shapes ----------

/** Mention fraction of one brand within a (promptText × provider) group. */
export interface BrandFraction {
  name: string;
  /** ok samples in the group where the brand was mentioned in prose. */
  mentions: number;
  /** mentions / samples (0 when samples is 0). */
  fraction: number;
}

/** One (promptText × provider) cell of the mention matrix. */
export interface MatrixCell {
  promptText: string;
  /** Prompt.category joined via promptText; absent when the prompt has none. */
  category?: string;
  provider: Provider;
  /** ok generation cells in this group — the honest denominator. */
  samples: number;
  /** Client mention fraction across the group's samples. */
  client: BrandFraction;
  /** Per curated competitor, in config.competitors order. */
  competitors: BrandFraction[];
  /**
   * Sample consistency flag: true iff the CLIENT mention fraction is strictly
   * between 0 and 1 (the client is named in some samples but not others — an
   * unstable answer worth re-sampling). Groups at 0 or 1 are consistent.
   */
  flaky: boolean;
}

/** One row of a citation-domain leaderboard. */
export interface DomainLeaderboardRow {
  domain: string;
  /** Number of citations to this domain across the scoped ok cells. */
  count: number;
  /** true iff domain equals the client's configured domain (normalized). */
  isClient: boolean;
  /** Curated competitor names whose configured domain equals this domain. */
  competitors: string[];
}

/** Citation-domain leaderboard, overall and per provider. */
export interface DomainLeaderboard {
  overall: DomainLeaderboardRow[];
  byProvider: Array<{ provider: Provider; rows: DomainLeaderboardRow[] }>;
}

/** Share-of-voice figure: client mentions over the client + competitor total. */
export interface ShareOfVoice {
  /** Client mention runs. */
  clientMentions: number;
  /** Σ mention runs over client + curated competitors. */
  totalMentions: number;
  /** clientMentions / totalMentions; 0 (never NaN) when the total is 0. */
  share: number;
}

/** Share of voice overall and per provider. */
export interface ShareOfVoiceResult {
  overall: ShareOfVoice;
  byProvider: Array<{ provider: Provider; sov: ShareOfVoice }>;
}

/** Client co-occurrence for one curated competitor. */
export interface CoOccurrenceRow {
  competitor: string;
  /** ok cells mentioning BOTH the competitor and the client ("appears with you"). */
  withClient: number;
  /** ok cells mentioning the competitor but NOT the client ("instead of you"). */
  withoutClient: number;
}

/** Client mention rollup for one prompt category. */
export interface CategoryRollup {
  category: string;
  /** ok generation cells whose prompt is in this category. */
  samples: number;
  /** Cells where the client was mentioned in prose. */
  clientMentions: number;
  /** clientMentions / samples (0 when samples is 0). */
  clientMentionRate: number;
}

export interface InsightsResult {
  client: BrandConfig;
  promptSetVersion: string;
  /** ok generation cells the insights were computed over. */
  totalSamples: number;
  /** (a) Prompt × provider mention matrix. */
  matrix: MatrixCell[];
  /** (b) Number of matrix cells flagged flaky. */
  flakyCount: number;
  /** (c) Citation-domain leaderboard, overall + per provider. */
  domainLeaderboard: DomainLeaderboard;
  /** (d) Share of voice, overall + per provider. */
  shareOfVoice: ShareOfVoiceResult;
  /** (e) Client co-occurrence, one row per curated competitor. */
  coOccurrence: CoOccurrenceRow[];
  /** (f) Per-category client rollup. */
  categories: CategoryRollup[];
  generatedAt: string;
}

// ---------- Helpers ----------

function brandFraction(name: string, cells: GenerationCell[], brand: BrandConfig): BrandFraction {
  let mentions = 0;
  for (const c of cells) {
    if (detectMention(c.responseText ?? "", brand)) mentions++;
  }
  return { name, mentions, fraction: cells.length === 0 ? 0 : mentions / cells.length };
}

/** Tally citation domains across ok cells into ranked leaderboard rows. */
function domainRows(
  cells: GenerationCell[],
  clientDomain: string,
  competitorsByDomain: Map<string, string[]>,
): DomainLeaderboardRow[] {
  const counts = new Map<string, number>();
  for (const c of cells) {
    for (const ci of c.citations ?? []) {
      const d = normalizeDomain(ci.domain);
      if (d.length === 0) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      isClient: domain === clientDomain,
      competitors: competitorsByDomain.get(domain) ?? [],
    }))
    // Descending by count, then domain ascending for a stable, deterministic order.
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function shareOfVoice(cells: GenerationCell[], client: BrandConfig, competitors: BrandConfig[]): ShareOfVoice {
  let clientMentions = 0;
  for (const c of cells) {
    if (detectMention(c.responseText ?? "", client)) clientMentions++;
  }
  let competitorMentions = 0;
  for (const comp of competitors) {
    for (const c of cells) {
      if (detectMention(c.responseText ?? "", comp)) competitorMentions++;
    }
  }
  const totalMentions = clientMentions + competitorMentions;
  return {
    clientMentions,
    totalMentions,
    // Guard the zero-denominator case: no mentions anywhere → 0, never NaN.
    share: totalMentions === 0 ? 0 : clientMentions / totalMentions,
  };
}

// ---------- Entry point ----------

/**
 * Compute all insights over the given cells. The caller is responsible for
 * having already restricted `cells` to the current config's set (enabled
 * providers, current prompts) via cellFilter.filterToCurrentCells — the same
 * filter the render pipeline applies — so insights and the report agree.
 */
export function computeInsights(cells: Cell[], config: RunConfig): InsightsResult {
  const genCells = cells.filter(
    (c): c is GenerationCell => c.kind === "generation" && c.status === "ok",
  );
  const { client, competitors } = config;
  const clientDomain = normalizeDomain(client.domain);

  // Curated competitor domains → the names sharing that domain (for leaderboard flags).
  const competitorsByDomain = new Map<string, string[]>();
  for (const comp of competitors) {
    const d = normalizeDomain(comp.domain);
    if (d.length === 0) continue;
    const list = competitorsByDomain.get(d);
    if (list) list.push(comp.name);
    else competitorsByDomain.set(d, [comp.name]);
  }

  // Prompt category lookup, joined via promptText (design: Prompt.category).
  const categoryByPrompt = new Map<string, string | undefined>();
  for (const p of config.promptSet.prompts) categoryByPrompt.set(p.text, p.category);

  // ---- (a) matrix + (b) flaky : group by (promptText × provider) ----
  const groups = new Map<string, GenerationCell[]>();
  const order: string[] = [];
  for (const c of genCells) {
    const key = `${c.provider} ${c.promptText}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else {
      groups.set(key, [c]);
      order.push(key);
    }
  }

  const matrix: MatrixCell[] = order.map((key) => {
    const group = groups.get(key)!;
    const first = group[0]!;
    const clientFrac = brandFraction(client.name, group, client);
    return {
      promptText: first.promptText,
      category: categoryByPrompt.get(first.promptText),
      provider: first.provider,
      samples: group.length,
      client: clientFrac,
      competitors: competitors.map((comp) => brandFraction(comp.name, group, comp)),
      flaky: clientFrac.fraction > 0 && clientFrac.fraction < 1,
    };
  });
  const flakyCount = matrix.filter((m) => m.flaky).length;

  // ---- (c) citation domain leaderboard (overall + per provider) ----
  const providers = [...new Set(genCells.map((c) => c.provider))];
  const domainLeaderboard: DomainLeaderboard = {
    overall: domainRows(genCells, clientDomain, competitorsByDomain),
    byProvider: providers.map((provider) => ({
      provider,
      rows: domainRows(
        genCells.filter((c) => c.provider === provider),
        clientDomain,
        competitorsByDomain,
      ),
    })),
  };

  // ---- (d) share of voice (overall + per provider) ----
  const shareOfVoiceResult: ShareOfVoiceResult = {
    overall: shareOfVoice(genCells, client, competitors),
    byProvider: providers.map((provider) => ({
      provider,
      sov: shareOfVoice(genCells.filter((c) => c.provider === provider), client, competitors),
    })),
  };

  // ---- (e) client co-occurrence, one row per curated competitor ----
  const coOccurrence: CoOccurrenceRow[] = competitors.map((comp) => {
    let withClient = 0;
    let withoutClient = 0;
    for (const c of genCells) {
      if (!detectMention(c.responseText ?? "", comp)) continue;
      if (detectMention(c.responseText ?? "", client)) withClient++;
      else withoutClient++;
    }
    return { competitor: comp.name, withClient, withoutClient };
  });

  // ---- (f) per-category client rollup ----
  const catAccum = new Map<string, { samples: number; clientMentions: number }>();
  const catOrder: string[] = [];
  for (const c of genCells) {
    const category = categoryByPrompt.get(c.promptText);
    if (category === undefined) continue;
    let acc = catAccum.get(category);
    if (acc === undefined) {
      acc = { samples: 0, clientMentions: 0 };
      catAccum.set(category, acc);
      catOrder.push(category);
    }
    acc.samples++;
    if (detectMention(c.responseText ?? "", client)) acc.clientMentions++;
  }
  const categories: CategoryRollup[] = catOrder.map((category) => {
    const acc = catAccum.get(category)!;
    return {
      category,
      samples: acc.samples,
      clientMentions: acc.clientMentions,
      clientMentionRate: acc.samples === 0 ? 0 : acc.clientMentions / acc.samples,
    };
  });

  return {
    client,
    promptSetVersion: config.promptSet.version,
    totalSamples: genCells.length,
    matrix,
    flakyCount,
    domainLeaderboard,
    shareOfVoice: shareOfVoiceResult,
    coOccurrence,
    categories,
    generatedAt: new Date().toISOString(),
  };
}
