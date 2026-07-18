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
import type { RunConfig, Provider } from "../../backend/core/types";

// Re-exported so Lane A/B can `import type { RunConfig } from "@/app/lib/contract"`
// without reaching across the tsconfig boundary into lib/ themselves.
export type { RunConfig, Provider };

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
  candidates: Array<{ name: string; count: number }>;
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

/** GET /api/reports response element. */
export interface ReportListEntry {
  file: string;
  /** ISO 8601 mtime. */
  mtime: string;
  /** true iff the config's results file exists and is newer than this report. */
  stale: boolean;
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
