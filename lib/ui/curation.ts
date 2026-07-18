/**
 * Curation — the discovered-competitor tally, extracted from cli.ts so the CLI
 * and the cockpit share ONE implementation (design decision 6, DRY). The tally
 * is the exact block cli.ts used to print after a run: dedupe extractions to
 * latest-wins, count brand mentions, exclude anything already curated as the
 * client or a competitor (case-insensitive), sorted by count descending.
 */
import { dedupeExtractions } from "../extract.js";
import type { BrandConfig, Cell, ExtractionCell, GenerationCell, RunConfig } from "../types.js";

export interface CurationCandidate {
  name: string;
  count: number;
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
  for (const c of latestExtractions) {
    for (const b of c.brands ?? []) {
      if (curatedNames.has(b.toLowerCase())) continue;
      discovered.set(b, (discovered.get(b) ?? 0) + 1);
    }
  }
  return [...discovered.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

/**
 * Promote named candidates into config.competitors. Each new competitor gets
 * aliases defaulting to [name] and an empty domain (match-safe — an empty
 * domain never matches, per the design note), inheriting the client's industry
 * so category-aware extraction keeps working. Names already present (by
 * case-insensitive name) are skipped; the input list is de-duplicated too.
 * Returns a new RunConfig — the input is not mutated.
 */
export function promoteCompetitors(config: RunConfig, names: string[]): RunConfig {
  const present = new Set(config.competitors.map((c) => c.name.toLowerCase()));
  const additions: BrandConfig[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (present.has(key)) continue;
    present.add(key);
    additions.push({
      name,
      aliases: [name],
      domain: "",
      industry: config.client.industry,
    });
  }
  return { ...config, competitors: [...config.competitors, ...additions] };
}
