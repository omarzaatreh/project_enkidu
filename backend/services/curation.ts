/**
 * Curation — the discovered-competitor tally, extracted from cli.ts so the CLI
 * and the cockpit share ONE implementation (design decision 6, DRY). The tally
 * is the exact block cli.ts used to print after a run: dedupe extractions to
 * latest-wins, count brand mentions, exclude anything already curated as the
 * client or a competitor (case-insensitive), sorted by count descending.
 */
import { dedupeExtractions } from "../core/extract.js";
import type { BrandConfig, Cell, ExtractionCell, GenerationCell, RunConfig } from "../core/types.js";

export interface CurationCandidate {
  name: string;
  count: number;
  /** Distinct providers whose answers named this brand (first-seen order). */
  providers: string[];
  /** Distinct prompt ids whose answers named this brand (first-seen order). */
  promptIds: string[];
  /**
   * ±120 chars of responseText around the brand's FIRST prose occurrence
   * (case-insensitive indexOf), whitespace-collapsed for inline display and
   * bracketed with … when truncated. Empty string when the extractor
   * normalized the name differently and it isn't found in any answer's prose.
   */
  exampleSnippet: string;
  /**
   * Best-guess domain for this competitor: the citation domain cited most often
   * across the ok cells that named this brand (normalized: lowercased, `www.`
   * stripped). Ties broken by the domain string ascending for determinism.
   * Empty string when no cell naming the brand carried any citation. This is a
   * SUGGESTION for the curation UI to pre-fill — the founder confirms or edits
   * it before promote, since the top co-cited domain may be a review/aggregator
   * site rather than the competitor's own.
   */
  suggestedDomain: string;
}

/** A candidate being promoted, with the domain the founder confirmed for it. */
export interface PromoteCompetitorInput {
  name: string;
  /** Bare host (e.g. "acme.com"); "" when the founder left it blank. */
  domain?: string;
}

/** Chars of context to show on either side of the brand's first prose hit. */
const SNIPPET_RADIUS = 120;

/**
 * Lowercase, trim, and strip a leading `www.` so a suggested/confirmed domain
 * matches citation domains the same way the insights leaderboard normalizes
 * both sides (mirrors normalizeDomain in insights.ts / aggregate.ts).
 */
function normalizeDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/**
 * ±SNIPPET_RADIUS chars of `responseText` around the first case-insensitive
 * occurrence of `brand`. Returns "" when responseText is absent or the brand
 * is not in the prose (extractor normalized the name differently). Whitespace
 * is collapsed so the snippet renders on one muted line; … marks truncation.
 */
function buildSnippet(responseText: string | undefined, brand: string): string {
  if (!responseText) return "";
  const idx = responseText.toLowerCase().indexOf(brand.toLowerCase());
  if (idx < 0) return "";
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(responseText.length, idx + brand.length + SNIPPET_RADIUS);
  let snippet = responseText.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < responseText.length) snippet = `${snippet}…`;
  return snippet;
}

/**
 * Discovered competitor candidates: brands the extractor surfaced that are not
 * already curated. Matches cli.ts byte-for-byte — same lowercase exclusion set,
 * same latest-extraction dedupe, same count map, same descending sort. The CLI
 * slices the top 15 for display; the UI shows the full list.
 *
 * When `currentPromptTexts` is supplied, extraction cells that join to an
 * orphaned generation cell (a prompt since removed from the config) are dropped,
 * so the discovered list matches the report the CLI/API render from the current
 * prompt set. Omitting it keeps the legacy all-cells behaviour.
 */
export function curationCandidates(
  cells: Cell[],
  config: RunConfig,
  currentPromptTexts?: Set<string>,
): CurationCandidate[] {
  const curatedNames = new Set(
    [config.client, ...config.competitors].flatMap((b) => [
      b.name.toLowerCase(),
      ...b.aliases.map((a) => a.toLowerCase()),
    ]),
  );
  // gen-cell lookup for the brand→provider/promptId/snippet join. Built once;
  // used only to enrich candidates — it never touches the count tally below.
  const genById = new Map<string, GenerationCell>();
  for (const c of cells) {
    if (c.kind === "generation") genById.set(c.cellId, c);
  }
  let extractionCells = cells.filter((c): c is ExtractionCell => c.kind === "extraction");
  if (currentPromptTexts) {
    const keptGenIds = new Set(
      cells
        .filter(
          (c): c is GenerationCell =>
            c.kind === "generation" && currentPromptTexts.has(c.promptText),
        )
        .map((c) => c.cellId),
    );
    extractionCells = extractionCells.filter((c) => keptGenIds.has(c.generationCellId));
  }
  const latestExtractions = dedupeExtractions(extractionCells);
  const discovered = new Map<string, number>();
  // Evidence keyed by the SAME exact brand string as the count map, so casings
  // that count separately (e.g. "Ykone" vs "YKONE") keep separate evidence.
  // domainCounts tallies citation domains seen in cells naming this brand, so
  // suggestedDomain can pick the most co-cited one (a good domain guess).
  const evidence = new Map<
    string,
    { providers: Set<string>; promptIds: Set<string>; snippet: string; domainCounts: Map<string, number> }
  >();
  for (const c of latestExtractions) {
    const gen = genById.get(c.generationCellId);
    for (const b of c.brands ?? []) {
      if (curatedNames.has(b.toLowerCase())) continue;
      // --- count tally: byte-identical to the pre-R5 CLI block ---
      discovered.set(b, (discovered.get(b) ?? 0) + 1);
      // --- evidence join (side-effect only; does not affect the tally) ---
      if (!gen) continue;
      let ev = evidence.get(b);
      if (!ev) {
        ev = { providers: new Set(), promptIds: new Set(), snippet: "", domainCounts: new Map() };
        evidence.set(b, ev);
      }
      ev.providers.add(gen.provider);
      ev.promptIds.add(gen.promptId);
      if (ev.snippet === "") ev.snippet = buildSnippet(gen.responseText, b);
      for (const ci of gen.citations ?? []) {
        const d = normalizeDomain(ci.domain);
        if (d.length === 0) continue;
        ev.domainCounts.set(d, (ev.domainCounts.get(d) ?? 0) + 1);
      }
    }
  }
  return [...discovered.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const ev = evidence.get(name);
      return {
        name,
        count,
        providers: ev ? [...ev.providers] : [],
        promptIds: ev ? [...ev.promptIds] : [],
        exampleSnippet: ev?.snippet ?? "",
        suggestedDomain: ev ? topDomain(ev.domainCounts) : "",
      };
    });
}

/**
 * The most-cited domain in the tally: highest count wins, the domain string
 * ascending breaks ties (deterministic). "" when the tally is empty.
 */
function topDomain(counts: Map<string, number>): string {
  let best = "";
  let bestCount = 0;
  for (const [domain, n] of counts) {
    if (n > bestCount || (n === bestCount && (best === "" || domain < best))) {
      best = domain;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Promote candidates into config.competitors. Each new competitor gets aliases
 * defaulting to [name], the founder-confirmed domain (normalized to a bare host;
 * "" stays match-safe per the design note — an empty domain never matches),
 * and inherits the client's industry so category-aware extraction keeps working.
 * A non-empty domain lights up the competitor's Insights leaderboard badge and
 * lets URL-form mentions match. Names already present (by case-insensitive name)
 * are skipped; the input list is de-duplicated by name too, keeping the FIRST
 * occurrence's domain. Returns a new RunConfig — the input is not mutated.
 */
export function promoteCompetitors(config: RunConfig, promotions: PromoteCompetitorInput[]): RunConfig {
  const present = new Set(config.competitors.map((c) => c.name.toLowerCase()));
  const additions: BrandConfig[] = [];
  for (const { name, domain } of promotions) {
    const key = name.toLowerCase();
    if (present.has(key)) continue;
    present.add(key);
    additions.push({
      name,
      aliases: [name],
      domain: normalizeDomain(domain ?? ""),
      industry: config.client.industry,
    });
  }
  return { ...config, competitors: [...config.competitors, ...additions] };
}
