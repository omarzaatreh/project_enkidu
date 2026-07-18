/**
 * Cockpit API contract — the coordination surface between the two later agents
 * (Lane A implements the API routes; Lane B builds the pages). BOTH import from
 * this file, so every type and constant here is a hard contract: change it and
 * you change both sides at once. Keep it in sync with backend/core/types.ts.
 *
 * Nothing here is "live" — no I/O, no logic — only the shapes of requests and
 * responses, the route paths, and the per-config data-layout paths.
 */

// RunConfig is the single source of truth for a run (see backend/core/types.ts). The GET
// /api/configs/[name] endpoint returns it verbatim; PUT accepts it verbatim.
// Bundler resolution (app/tsconfig.json) resolves this cross-config import.
import type { RunConfig, Provider, Citation } from "../../backend/core/types";
// Insights analytics shapes live in core (pure); GET /api/insights returns
// InsightsResult verbatim, so the cockpit imports the whole set from here.
import type {
  InsightsResult,
  MatrixCell,
  BrandFraction,
  DomainLeaderboard,
  DomainLeaderboardRow,
  ShareOfVoiceResult,
  ShareOfVoice,
  CoOccurrenceRow,
  CategoryRollup,
} from "../../backend/core/insights";

// Re-exported so Lane A/B can `import type { RunConfig } from "@/app/lib/contract"`
// without reaching across the tsconfig boundary into lib/ themselves.
export type { RunConfig, Provider, Citation };
export type {
  InsightsResult,
  MatrixCell,
  BrandFraction,
  DomainLeaderboard,
  DomainLeaderboardRow,
  ShareOfVoiceResult,
  ShareOfVoice,
  CoOccurrenceRow,
  CategoryRollup,
};

// ---------------------------------------------------------------------------
// Response payload types
// ---------------------------------------------------------------------------

/**
 * A one-line summary of a config file, for the config list screen. Derived
 * server-side from a RunConfig — NOT stored. `name` is the filename minus
 * `.json`; `models` is `Object.keys(config.models)` (enabled providers only).
 */
export interface ConfigSummary {
  /** Filename minus `.json` — the id used in every per-config route/path. */
  name: string;
  /** config.client.name. */
  clientName: string;
  /** config.promptSet.prompts.length. */
  promptCount: number;
  /** Object.keys(config.models) — the enabled providers. */
  models: string[];
  /** config.samplesPerPrompt. */
  samplesPerPrompt: number;
}

/**
 * Cost/scope estimate for a run, resume-aware. `newCalls` counts only cells
 * NOT already present in the config's results file, so the founder sees the
 * marginal spend of resuming rather than the full run cost.
 */
export interface EstimateResponse {
  /** prompts × enabled models × samplesPerPrompt — the full planned run. */
  totalCalls: number;
  /** Cells NOT already completed in resultsPath(name) — the marginal run. */
  newCalls: number;
  /** newCalls × per-call price constants (app/lib/pricing.ts). Rough. */
  estUsd: number;
  /** Human-readable caveat, e.g. "rough estimate; excludes extraction pass". */
  note: string;
}

/**
 * One frame of run progress, streamed over SSE from GET /api/runs/progress.
 * Progress is derived from disk (results.jsonl), not memory, so it survives a
 * tab close or server restart. The stream ends with a terminal `done` frame.
 */
export type ProgressEvent =
  | {
      phase: "generation" | "extraction";
      done: number;
      total: number;
      failed: number;
      /**
       * (R7) Per-enabled-provider generation breakdown. OPTIONAL and additive:
       * old clients ignore it and old-shape frames (emitted without it, e.g. the
       * in-process emitter ticks) still parse. Present on disk-derived frames.
       */
      byProvider?: ProviderProgress[];
    }
  | {
      /** Terminal frame — the stream closes after this. */
      phase: "done";
      /** Providers below the outage threshold; empty on a clean run. */
      outageProviders: string[];
    };

// ---------------------------------------------------------------------------
// API — endpoint paths + request/response shapes
//
// Path builders take the same `name` (filename minus `.json`) used everywhere.
// Query-string endpoints expose a `path(name)` helper that returns the full
// URL including `?config=...` so callers never hand-assemble query strings.
// ---------------------------------------------------------------------------

export const API = {
  /**
   * GET /api/configs → ConfigSummary[]
   * Lists config/*.json as summaries (one per file).
   */
  configs: "/api/configs",

  /**
   * GET  /api/configs/[name] → RunConfig
   *   Loads config/[name].json verbatim. `name` = filename minus `.json`.
   * PUT  /api/configs/[name]  body: RunConfig → { ok: true; promptSetVersion: string }
   *   Writes the config back. The server AUTO-BUMPS promptSet.version to
   *   "v-" + first 8 hex chars of sha256(JSON.stringify(prompts.map(p => p.text)))
   *   whenever the prompt texts changed, and returns the resulting version.
   *   Callers must NOT set the version themselves.
   */
  config: (name: string): string => `/api/configs/${encodeURIComponent(name)}`,

  /**
   * GET /api/estimate?config=name → EstimateResponse
   * Resume-aware cost/scope estimate for the named config.
   */
  estimate: "/api/estimate",
  estimatePath: (name: string): string =>
    `/api/estimate?config=${encodeURIComponent(name)}`,

  /**
   * POST /api/runs  body: { configName: string }
   *   → { started: true }
   *   → 409 { error: "run-in-progress" }  (run lock held by another run)
   * Acquires the run lock and starts the in-process run driver.
   */
  runs: "/api/runs",

  /**
   * GET /api/runs/active → { running: boolean; configName?: string; startedAt?: string }
   * Reports whether a run currently holds the lock.
   */
  runsActive: "/api/runs/active",

  /**
   * GET /api/runs/progress?config=name → Server-Sent Events
   * Each `data:` line is a ProgressEvent (JSON). Emits generation/extraction
   * frames, then one terminal { phase: "done", outageProviders }, then closes.
   */
  runsProgress: "/api/runs/progress",
  runsProgressPath: (name: string): string =>
    `/api/runs/progress?config=${encodeURIComponent(name)}`,

  /**
   * GET /api/curation?config=name
   *   → { candidates: Array<{ name: string; count: number }> }
   * The discovered-competitor tally (lib/curation.ts) minus already-curated
   * brands, sorted by count. Feeds the checkbox-promote curation screen.
   */
  curation: "/api/curation",
  curationPath: (name: string): string =>
    `/api/curation?config=${encodeURIComponent(name)}`,

  /**
   * POST /api/curation  body: { configName: string; promote: string[] }
   *   → { ok: true; competitors: number }
   * Promotes the named candidates into config.competitors (aliases default to
   * [name]; domain empty — match-safe) and returns the new competitor count.
   */
  curationPromote: "/api/curation",

  /**
   * POST /api/render  body: { configName: string; acknowledgeOutage?: boolean }
   *   → { reportFile: string }
   *   → 409 OutageResponse { error: "outage"; outageProviders; completion }
   * Renders results.jsonl → report HTML. Refuses on a provider outage unless
   * body.acknowledgeOutage === true.
   */
  render: "/api/render",

  /**
   * GET /api/insights?config=name → InsightsResult
   * Prompt × provider mention matrix, citation-domain leaderboard, share of
   * voice, consistency (flaky) flags, client co-occurrence, and per-category
   * rollup — all derived from the CURRENT config's cell set (orphans excluded,
   * exactly as the report). Read-only; touches only config/ and results/.
   */
  insights: "/api/insights",
  insightsPath: (name: string): string =>
    `/api/insights?config=${encodeURIComponent(name)}`,

  /**
   * GET /api/reports → ReportListEntry[] { file; mtime; stale }
   * Lists rendered reports, newest first (mtime is ISO 8601). `stale` is true
   * when the config's results file is newer than the rendered report.
   */
  reports: "/api/reports",

  /**
   * GET /api/reports/[file] → the report HTML (Content-Type: text/html)
   * Serves one rendered report file for preview.
   */
  report: (file: string): string =>
    `/api/reports/${encodeURIComponent(file)}`,

  /**
   * GET /api/answers?config=name&promptId=id → AnswersResponse
   * The OK generation cells for ONE prompt — prose, citations, model, sample
   * index, timestamp — each joined to its latest extraction's discovered brands,
   * plus the client/competitor aliases for mention highlighting. Joins answers by
   * promptText (resolved from promptId server-side) and applies the SAME
   * orphan/enabled-provider filter as the heatmap. Scoped to one prompt so the
   * payload stays small. Read-only; touches only config/ + results/.
   */
  answers: "/api/answers",
  answersPath: (name: string, promptId: string): string =>
    `/api/answers?config=${encodeURIComponent(name)}&promptId=${encodeURIComponent(promptId)}`,
} as const;

// ---------------------------------------------------------------------------
// API request/response body types (named companions to the JSDoc above)
// ---------------------------------------------------------------------------

/** PUT /api/configs/[name] response. */
export interface PutConfigResponse {
  ok: true;
  promptSetVersion: string;
}

/** POST /api/runs request body. */
export interface StartRunRequest {
  configName: string;
}

/** POST /api/runs success response. 409 body is { error: "run-in-progress" }. */
export interface StartRunResponse {
  started: true;
}

/** GET /api/runs/active response. */
export interface ActiveRunResponse {
  running: boolean;
  configName?: string;
  startedAt?: string;
}

/** GET /api/curation response. */
export interface CurationResponse {
  candidates: CurationCandidate[];
}

/** POST /api/curation request body. */
export interface Curation_PromoteRequest {
  configName: string;
  promote: string[];
}

/** POST /api/curation (promote) success response. */
export interface CurationPromoteResponse {
  ok: true;
  competitors: number;
}

/** POST /api/render request body. */
export interface RenderRequest {
  configName: string;
  /** When true, render proceeds despite a provider outage. */
  acknowledgeOutage?: boolean;
}

/** POST /api/render success response. 409 body is OutageResponse. */
export interface RenderResponse {
  reportFile: string;
}

/** 409 body shared by POST /api/render (and any outage-gated endpoint). */
export interface OutageResponse {
  error: "outage";
  outageProviders: string[];
  /**
   * Per enabled provider, how far the CURRENT prompt set got. `completed` is
   * ok cells for prompts still in the config (orphans excluded); `planned` is
   * prompts × samplesPerPrompt. Lets the UI explain the outage concretely.
   */
  completion: Array<{ provider: string; completed: number; planned: number }>;
}

/**
 * One OK generation cell for a prompt (GET /api/answers), joined to its latest
 * extraction's discovered brands. `responseText` is raw prose — the client MUST
 * render it as escaped text (never dangerouslySetInnerHTML).
 */
export interface AnswerCell {
  provider: Provider;
  model: string;
  sampleIndex: number;
  /** Raw prose answer. May contain markdown — render as literal text. */
  responseText: string;
  /** Parsed citations from provider metadata (empty when unavailable). */
  citations: Citation[];
  timestamp: string;
  /** Latest-wins extractor-discovered brands for this cell. */
  brands: string[];
}

/**
 * GET /api/answers response: one prompt's OK samples plus the alias sets the
 * panel highlights with. `clientAliases`/`competitorAliases` are scoped from the
 * same config the cells were filtered against, so client-side highlighting
 * mirrors the server's word-boundary alias semantics.
 */
export interface AnswersResponse {
  /** The promptId echoed from the request. */
  promptId: string;
  /** The hash-faithful prompt text the answers were joined by. */
  promptText: string;
  /** client.name + aliases + domain (blanks dropped) — highlighted in accent. */
  clientAliases: string[];
  /** Every curated competitor's name + aliases — highlighted underlined. */
  competitorAliases: string[];
  /** OK samples for this prompt, sorted by provider then sampleIndex. */
  cells: AnswerCell[];
}

/** GET /api/reports response element. */
export interface ReportListEntry {
  file: string;
  /** ISO 8601 mtime. */
  mtime: string;
  /** true iff the config's results file exists and is newer than this report. */
  stale: boolean;
  /**
   * (R8) Config name parsed from the filename (`<config>-<date>.html`), or null
   * when the filename doesn't match. Drives the friendly title, the per-config
   * filter, and the target of a stale-report re-render.
   */
  configName: string | null;
  /** (R8) Report date (YYYY-MM-DD) parsed from the filename, or null. */
  reportDate: string | null;
}

/**
 * (R8) Split a rendered-report filename into its config name and date — the
 * inverse of `reportPath`. Reports are named `${configName}-YYYY-MM-DD.html`;
 * anything that doesn't match yields `{ configName: null, reportDate: null }`.
 * Pure (no I/O) so it can be unit-tested without touching the filesystem, and
 * is the single source of truth for the report-name shape (route + tests).
 */
const REPORT_NAME_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.html$/;
export function parseReportName(file: string): {
  configName: string | null;
  reportDate: string | null;
} {
  const m = REPORT_NAME_RE.exec(file);
  if (!m) return { configName: null, reportDate: null };
  return { configName: m[1] ?? null, reportDate: m[2] ?? null };
}

// ---------------------------------------------------------------------------
// UI route paths (the pages the two later agents build). Kept here so the nav
// and any client-side links share one source of truth with the API contract.
// ---------------------------------------------------------------------------

export const ROUTES = {
  home: "/",
  clients: "/clients",
  run: "/run",
  prompts: "/prompts",
  insights: "/insights",
  curation: "/curation",
  reports: "/reports",
} as const;

// ---------------------------------------------------------------------------
// DATA-LAYOUT — per-config on-disk paths (design amendment 9, load-bearing
// decision 1/2: config JSON is the source of truth; progress is derived from
// disk). Lane A implements against these; the cockpit only DEFINES them. Paths
// are repo-root-relative. The CLI's shared results/results.jsonl default is
// superseded by these per-config paths.
// ---------------------------------------------------------------------------

/** Per-config append-only cell log, e.g. results/tikit.jsonl. */
export const resultsPath = (name: string): string => `results/${name}.jsonl`;

/** Per-config trend history, e.g. results/tikit.trend.json. */
export const trendPath = (name: string): string => `results/${name}.trend.json`;

/** Per-config rendered report for a date, e.g. reports/tikit-2026-07-18.html. */
export const reportPath = (name: string, date: string): string =>
  `reports/${name}-${date}.html`;

/** Global single-run lock — one active run at a time (decision 3). */
export const lockPath = "results/.run.lock";

// ---------------------------------------------------------------------------
// R5: curation candidate evidence. Kept in sync with backend/services/curation.ts
// (CurationCandidate). Appended additively — the count/name tally is unchanged;
// providers/promptIds/exampleSnippet are provenance shown per candidate row so
// the founder can promote/ignore from evidence instead of a bare name+count.
// ---------------------------------------------------------------------------

/**
 * One discovered-competitor candidate with the evidence behind it. `name` and
 * `count` are the byte-identical CLI tally; the rest is provenance for the
 * curation UI. `exampleSnippet` is RAW prose — the client MUST render it as
 * escaped text (React default), never dangerouslySetInnerHTML.
 */
export interface CurationCandidate {
  /** The exact brand string as the extractor returned it. */
  name: string;
  /** Mentions across deduped latest extractions (unchanged from pre-R5). */
  count: number;
  /** Distinct providers whose answers named this brand (first-seen order). */
  providers: string[];
  /** Distinct prompt ids whose answers named this brand (first-seen order). */
  promptIds: string[];
  /** ±120 chars of prose around the brand's first occurrence; "" when absent. */
  exampleSnippet: string;
}

// ---------------------------------------------------------------------------
// R7: live progress that explains itself — per-provider generation breakdown
// and the failed-generation list. Appended additively; kept in sync with
// backend/services/progress.ts (ProviderProgress / FailedGeneration).
// ---------------------------------------------------------------------------

/**
 * One enabled provider's slice of the generation phase. Referenced by the
 * OPTIONAL `byProvider` field on a generation/extraction ProgressEvent so the
 * cockpit can draw one slim bar per provider that matches the disk totals.
 */
export interface ProviderProgress {
  /** Provider key, e.g. "anthropic". */
  provider: string;
  done: number;
  total: number;
  failed: number;
}

/**
 * One latest-wins failed generation cell for the CURRENT plan (GET
 * /api/runs/failures). `error` is the RAW stored adapter message — the client
 * MUST render it as escaped text (React default), never dangerouslySetInnerHTML.
 */
export interface RunFailure {
  promptId: string;
  provider: Provider;
  sampleIndex: number;
  /** Stored adapter error string ("" when a failed cell recorded none). */
  error: string;
  timestamp: string;
}

/** GET /api/runs/failures response. */
export interface FailuresResponse {
  failures: RunFailure[];
}

// GET /api/runs/failures?config=name → FailuresResponse
//   Latest-wins failed generation cells for the current plan (same run/plan +
//   cell-loading as /api/runs/progress). A cell that failed then succeeded on a
//   retry is represented by its ok retry and is NOT listed. Read-only; touches
//   only results/ + config/ server-side.
export const RUNS_FAILURES = "/api/runs/failures";
export const runsFailuresPath = (name: string): string =>
  `/api/runs/failures?config=${encodeURIComponent(name)}`;
