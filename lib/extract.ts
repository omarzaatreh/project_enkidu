/**
 * Competitor extraction + mention detection (design doc, extraction spec).
 *
 * Everything here is PROSE-ONLY: mention detection runs over response text
 * via word-boundary alias matching. Citation metadata never flows through
 * this module — citations feed the gap table in aggregate.ts, not mentions.
 */

import type {
  BrandConfig,
  CompetitorStat,
  ExtractionCell,
  GenerationCell,
} from "./types.js";
import { normalizeText, proseContainsAlias } from "./shared/normalize.js";

/** Max non-client rows in the competitor tally (client row is always kept). */
const MAX_NON_CLIENT_ROWS = 5;

/**
 * True iff the brand is mentioned in the response PROSE.
 * Matches word-boundary over [name, ...aliases, domain]. The domain counts
 * only when it literally appears in prose — never via citation metadata.
 */
export function detectMention(responseText: string, brand: BrandConfig): boolean {
  const aliases = [brand.name, ...brand.aliases, brand.domain];
  return aliases.some((alias) => proseContainsAlias(responseText, alias));
}

/**
 * Prompt for the cheap extractor model: strict JSON array of brand names,
 * no prose. parseExtractionResponse is the tolerant counterpart.
 */
export function buildExtractionPrompt(responseText: string): string {
  return [
    "You extract company and brand names from text.",
    "",
    "List every company or brand name mentioned in the text below.",
    "Respond with a STRICT JSON array of strings and nothing else —",
    'no prose, no explanation, no markdown. Example: ["Acme Corp", "Globex"]',
    "Return [] if none are mentioned.",
    "",
    "Text:",
    responseText,
  ].join("\n");
}

/**
 * Tolerant parse of the extractor's reply.
 *
 * Accepts a bare JSON array, or an array inside ``` / ```json fences.
 * Entries are trimmed; empties dropped; deduped case-insensitively via
 * normalizeText, keeping first-seen casing. Anything malformed or not an
 * array throws — the caller marks the extraction cell failed.
 */
export function parseExtractionResponse(raw: string): string[] {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1] !== undefined) {
    text = fenced[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`extraction response is not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`extraction response is not a JSON array: ${raw.slice(0, 200)}`);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = normalizeText(trimmed);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Competitor tally over ok generation cells.
 *
 * - Curated competitors: counted via prose detectMention on responseText.
 * - Discovered brands: from ok extraction cells joined to ok generation
 *   cells via generationCellId. Any brand that normalizes equal to the
 *   client's name/aliases or a curated competitor's name/aliases is
 *   excluded (no double counting). Deduped per cell so one cell counts a
 *   discovered brand at most once.
 * - Client: prose detectMention, isClient: true — ALWAYS in the output,
 *   even at 0 mentions.
 *
 * Sorted descending by mentions; capped at client row + top 5 non-client.
 */
export function tallyCompetitors(
  cells: GenerationCell[],
  extractions: ExtractionCell[],
  client: BrandConfig,
  curated: BrandConfig[],
): CompetitorStat[] {
  const okCells = cells.filter(
    (c): c is GenerationCell & { responseText: string } =>
      c.status === "ok" && typeof c.responseText === "string",
  );

  // Names/aliases whose normalized forms are excluded from discovery.
  const excluded = new Set<string>();
  for (const alias of [client.name, ...client.aliases]) {
    excluded.add(normalizeText(alias));
  }
  for (const comp of curated) {
    for (const alias of [comp.name, ...comp.aliases]) {
      excluded.add(normalizeText(alias));
    }
  }

  // (c) Client row — always present.
  let clientMentions = 0;
  for (const cell of okCells) {
    if (detectMention(cell.responseText, client)) clientMentions++;
  }
  const clientRow: CompetitorStat = {
    name: client.name,
    mentions: clientMentions,
    isClient: true,
  };

  // (a) Curated competitors via prose detection.
  const curatedRows: CompetitorStat[] = curated.map((comp) => {
    let mentions = 0;
    for (const cell of okCells) {
      if (detectMention(cell.responseText, comp)) mentions++;
    }
    return { name: comp.name, mentions, isClient: false };
  });

  // (b) Discovered brands from ok extraction cells joined to ok gen cells.
  const okExtractionsByGen = new Map<string, ExtractionCell[]>();
  for (const ext of extractions) {
    if (ext.status !== "ok" || ext.brands === undefined) continue;
    const list = okExtractionsByGen.get(ext.generationCellId);
    if (list) list.push(ext);
    else okExtractionsByGen.set(ext.generationCellId, [ext]);
  }

  const discovered = new Map<string, { name: string; mentions: number }>();
  for (const cell of okCells) {
    const exts = okExtractionsByGen.get(cell.cellId);
    if (exts === undefined) continue;
    const seenThisCell = new Set<string>();
    for (const ext of exts) {
      for (const brand of ext.brands ?? []) {
        const trimmed = brand.trim();
        if (trimmed.length === 0) continue;
        const key = normalizeText(trimmed);
        if (key.length === 0 || excluded.has(key) || seenThisCell.has(key)) continue;
        seenThisCell.add(key);
        const existing = discovered.get(key);
        if (existing) existing.mentions++;
        else discovered.set(key, { name: trimmed, mentions: 1 });
      }
    }
  }
  const discoveredRows: CompetitorStat[] = [...discovered.values()].map((d) => ({
    name: d.name,
    mentions: d.mentions,
    isClient: false,
  }));

  // Sort everything descending by mentions (stable), then cap at
  // client + top 5 non-client. Client survives even at 0 mentions.
  const sorted = [clientRow, ...curatedRows, ...discoveredRows].sort(
    (a, b) => b.mentions - a.mentions,
  );
  const result: CompetitorStat[] = [];
  let nonClientKept = 0;
  for (const row of sorted) {
    if (row.isClient) {
      result.push(row);
    } else if (nonClientKept < MAX_NON_CLIENT_ROWS) {
      result.push(row);
      nonClientKept++;
    }
  }
  return result;
}
