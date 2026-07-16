/**
 * Shared types for the AI Visibility Report pipeline.
 *
 * Data flow (design doc, "Engineering Review Amendments" §v1 pipeline):
 *
 *   prompts.v1.json ─► cli run ─► adapters ─► results.jsonl (cells) ─►
 *   cli render ─► extract ─► aggregate ─► report.html
 *
 * Every paid unit of work is a Cell appended to results.jsonl, keyed by a
 * content hash so a resumed run skips completed cells and an edited prompt
 * automatically invalidates only its own cells.
 */

export type Provider = "openai" | "anthropic" | "perplexity";

export interface Prompt {
  /** Stable slug, e.g. "best-influencer-agencies-uk". Not used in cell hashing. */
  id: string;
  /** The literal prompt text sent to the model. Hashed into cell IDs. */
  text: string;
  /** Buying-intent bucket, e.g. "recommendation" | "comparison" | "informational". */
  category?: string;
}

export interface PromptSet {
  /** Bumped on ANY prompt edit. Trends only compare same-version runs. */
  version: string;
  prompts: Prompt[];
}

export interface BrandConfig {
  /** Canonical display name, e.g. "TIkit". */
  name: string;
  /**
   * Normalized alias list: legal name, product names, common misspellings.
   * Matching is word-boundary on normalized text — see lib/normalize.ts.
   */
  aliases: string[];
  /** Bare domain, e.g. "tikit.com". Counts as a mention ONLY in prose. */
  domain: string;
}

export interface WhiteLabelConfig {
  agencyName: string;
  /** Data URI or absolute URL; omitted → text-only header. */
  logoUrl?: string;
  accentColor: string;
}

export interface RunConfig {
  client: BrandConfig;
  /** Hand-curated after the discovery pass; may start empty. */
  competitors: BrandConfig[];
  promptSet: PromptSet;
  /** Pinned model ID per provider — printed in the methodology footer. */
  models: Record<Provider, string>;
  samplesPerPrompt: number;
  whiteLabel: WhiteLabelConfig;
  /** ISO date range shown on the report header. */
  dateRange: { from: string; to: string };
}

export interface Citation {
  url: string;
  /** Lowercased registrable domain, e.g. "byrdie.com". */
  domain: string;
  title?: string;
}

/** One (prompt × model × sample) API call. kind discriminates in results.jsonl. */
export interface GenerationCell {
  kind: "generation";
  /** sha256("gen|" + promptText + "|" + provider + "|" + model + "|" + groundingConfig + "|" + sampleIndex) */
  cellId: string;
  promptId: string;
  promptText: string;
  provider: Provider;
  model: string;
  /** e.g. "web_search:on" — part of the hash so a grounding change invalidates cells. */
  groundingConfig: string;
  sampleIndex: number;
  status: "ok" | "failed";
  /** Prose answer text. Present iff status === "ok". */
  responseText?: string;
  /** Parsed citations from provider metadata. Empty array when unavailable/malformed. */
  citations?: Citation[];
  error?: string;
  timestamp: string;
}

/** One competitor-discovery extraction call over a completed generation cell. */
export interface ExtractionCell {
  kind: "extraction";
  /** sha256("ext|" + generationCellId + "|" + extractorModel) */
  cellId: string;
  generationCellId: string;
  extractorModel: string;
  status: "ok" | "failed";
  /** Brand names the extractor found in the response prose. */
  brands?: string[];
  error?: string;
  timestamp: string;
}

export type Cell = GenerationCell | ExtractionCell;

/** What an adapter returns for one successful grounded call. */
export interface AdapterResponse {
  responseText: string;
  citations: Citation[];
}

export interface AdapterRequest {
  promptText: string;
  model: string;
}

export type Adapter = (req: AdapterRequest) => Promise<AdapterResponse>;

// ---------- Aggregation output (consumed by render) ----------

export interface ModelStats {
  provider: Provider;
  model: string;
  /** Runs where status === "ok". The honest denominator. */
  completedRuns: number;
  plannedRuns: number;
  /** Client mentioned in response PROSE (alias match). */
  mentionRuns: number;
  /** Client domain appeared in citation METADATA. Separate labeled figure. */
  citedRuns: number;
  /** Cells excluded for having <3 of samplesPerPrompt completed samples. */
  insufficientPrompts: number;
}

export interface CompetitorStat {
  name: string;
  mentions: number;
  isClient: boolean;
}

export interface CitationGapRow {
  domain: string;
  exampleTitle?: string;
  competitorsCited: string[];
  /** true iff this domain appeared as a citation in ≥1 completed run where the client was mentioned. */
  clientCited: boolean;
}

export interface TrendPoint {
  date: string;
  promptSetVersion: string;
  overallMentionRate: number;
}

export interface AggregateResult {
  client: BrandConfig;
  perModel: ModelStats[];
  competitors: CompetitorStat[];
  citationGaps: CitationGapRow[];
  /** Empty on the first run — render omits the trend block. */
  trend: TrendPoint[];
  promptSetVersion: string;
  totalPlanned: number;
  totalCompleted: number;
  generatedAt: string;
}

// ---------- Runner policy constants (design doc, partial-failure policy) ----------

export const RETRIES_PER_CALL = 2;
export const MIN_SAMPLES_PER_CELL = 3;
/** A provider completing < this fraction of its cells holds the run. */
export const PROVIDER_OUTAGE_THRESHOLD = 0.5;
