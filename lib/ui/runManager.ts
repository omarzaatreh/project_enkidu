/**
 * LocalRunDriver + run lock (design decisions 2 & 3). One active run at a time,
 * guarded by an atomically-created lockfile; progress is broadcast in-process
 * for SSE but ALSO derivable from disk (see progress.ts) so a subscriber that
 * missed the emitter still sees the truth.
 *
 * This is the ONE abstraction Path A must get right (design doc): Path B swaps
 * in an InngestRunDriver behind the same start/active surface. Business logic
 * lives here under the root tsconfig; app/api/runs/* are thin wrappers.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cell, GenerationCell, Provider, RunConfig } from "../types.js";
import { makeAdapters } from "../adapters/index.js";
import { enabledProviders, runExtraction, runGeneration } from "../runner.js";
import { loadConfig } from "./configStore.js";
import { computeOutageProviders } from "./renderPipeline.js";
import { ENV_KEY, loadDotEnv, MissingKeyError } from "./env.js";

// Per-config on-disk layout (mirrors app/lib/contract.ts — kept in sync there;
// lib/ui cannot import app/ under the root tsconfig).
export const LOCK_PATH = "results/.run.lock";
const resultsPathFor = (name: string): string => `results/${name}.jsonl`;

/** Lockfile contents. */
export interface LockInfo {
  pid: number;
  configName: string;
  startedAt: string;
}

/** Shape returned to GET /api/runs/active. */
export interface ActiveRun {
  running: boolean;
  configName?: string;
  startedAt?: string;
}

/** Thrown by startRun/acquireLock when a live run already holds the lock. */
export class RunInProgressError extends Error {
  constructor(public readonly lock: LockInfo) {
    super(`a run is already in progress (config "${lock.configName}", pid ${lock.pid})`);
    this.name = "RunInProgressError";
  }
}

/**
 * In-process event bus for SSE. Events:
 *   "progress" → { configName, phase: "generation"|"extraction", done, total, failed }
 *   "done"     → { configName, outageProviders: string[] }
 * SSE also polls disk, so a subscriber attached after a tick still catches up.
 */
export const runEvents = new EventEmitter();
runEvents.setMaxListeners(0);

export interface ProgressTick {
  configName: string;
  phase: "generation" | "extraction";
  done: number;
  total: number;
  failed: number;
}
export interface DoneTick {
  configName: string;
  outageProviders: string[];
}

/** Default liveness probe: is `pid` a running process we could signal? */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → the process exists but we may not signal it → still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockFile(lockPath: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
  } catch {
    return undefined;
  }
}

function loadCells(path: string): Cell[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Cell);
}

/**
 * Acquire the run lock atomically (writeFile "wx"). If a lock already exists,
 * recover it only when its owning pid is dead (stale-lock recovery); otherwise
 * throw RunInProgressError. Options are injectable for tests.
 */
export function acquireLock(
  configName: string,
  opts: {
    lockPath?: string;
    pid?: number;
    startedAt?: string;
    isAlive?: (pid: number) => boolean;
  } = {},
): LockInfo {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const info: LockInfo = {
    pid: opts.pid ?? process.pid,
    configName,
    startedAt: opts.startedAt ?? new Date().toISOString(),
  };

  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, JSON.stringify(info), { flag: "wx" });
    return info;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = readLockFile(lockPath);
    if (existing && isAlive(existing.pid)) throw new RunInProgressError(existing);
    // Stale (dead owner) or unreadable — reclaim.
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, JSON.stringify(info), { flag: "wx" });
    return info;
  }
}

/** Release the lock. When ownerPid is given, only release if we still own it. */
export function releaseLock(opts: { lockPath?: string; ownerPid?: number } = {}): void {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  if (!existsSync(lockPath)) return;
  if (opts.ownerPid !== undefined) {
    const info = readLockFile(lockPath);
    if (info && info.pid !== opts.ownerPid) return;
  }
  rmSync(lockPath, { force: true });
}

/** Read the lock → ActiveRun. A stale lock (dead owner) reports not-running. */
export function activeRun(
  opts: { lockPath?: string; isAlive?: (pid: number) => boolean } = {},
): ActiveRun {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  if (!existsSync(lockPath)) return { running: false };
  const info = readLockFile(lockPath);
  if (!info || !isAlive(info.pid)) return { running: false };
  return { running: true, configName: info.configName, startedAt: info.startedAt };
}

/**
 * Start a run: acquire the lock (or throw RunInProgressError), load config +
 * existing cells, build adapters from env keys for enabled providers (missing
 * key → throw BEFORE spending, releasing the lock), then fire-and-forget the
 * generation → extraction passes, releasing the lock in a finally.
 */
export function startRun(configName: string): void {
  const lock = acquireLock(configName);

  let config: RunConfig;
  let existingCells: Cell[];
  let keys: Partial<Record<Provider, string>>;
  let anthropicKey: string;
  try {
    loadDotEnv();
    config = loadConfig(configName);
    const providers = enabledProviders(config);
    if (providers.length === 0) throw new Error(`config "${configName}" enables no providers`);
    existingCells = loadCells(resultsPathFor(configName));

    keys = {};
    for (const p of providers) {
      const value = process.env[ENV_KEY[p]];
      if (!value) throw new MissingKeyError(ENV_KEY[p]);
      keys[p] = value;
    }
    // The extraction pass always runs on a cheap Anthropic model.
    anthropicKey = keys.anthropic ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!anthropicKey) throw new MissingKeyError(ENV_KEY.anthropic);
  } catch (err) {
    releaseLock({ ownerPid: lock.pid });
    throw err;
  }

  void driveRun(configName, config, existingCells, keys, anthropicKey, lock).catch(() => {
    // Errors are surfaced as failed cells + the done frame; never unhandled.
  });
}

async function driveRun(
  configName: string,
  config: RunConfig,
  existingCells: Cell[],
  keys: Partial<Record<Provider, string>>,
  anthropicKey: string,
  lock: LockInfo,
): Promise<void> {
  const resultsPath = resultsPathFor(configName);
  mkdirSync(dirname(resultsPath), { recursive: true });
  const append = (cell: Cell): void => {
    appendFileSync(resultsPath, `${JSON.stringify(cell)}\n`);
  };

  let outageProviders: string[] = [];
  try {
    const okGeneration = existingCells.filter(
      (c): c is GenerationCell => c.kind === "generation" && c.status === "ok",
    );
    const existingCellIds = new Set(okGeneration.map((c) => c.cellId));
    const existingOkByProvider: Partial<Record<Provider, number>> = {};
    for (const c of okGeneration) {
      existingOkByProvider[c.provider] = (existingOkByProvider[c.provider] ?? 0) + 1;
    }

    const outcome = await runGeneration({
      config,
      adapters: makeAdapters(keys),
      existingCellIds,
      existingOkByProvider,
      append,
      onProgress: (p) =>
        runEvents.emit("progress", {
          configName,
          phase: "generation",
          done: p.done,
          total: p.total,
          failed: p.failed,
        } satisfies ProgressTick),
    });
    outageProviders = outcome.outageProviders;

    // Re-read: only enabled providers' cells are extracted (removed providers'
    // old cells must not spend extraction budget).
    const enabledSet = new Set(enabledProviders(config));
    const allCells = loadCells(resultsPath).filter(
      (c) => c.kind === "extraction" || enabledSet.has(c.provider),
    );
    await runExtraction({
      cells: allCells,
      client: config.client,
      anthropicApiKey: anthropicKey,
      append,
      onProgress: (p) =>
        runEvents.emit("progress", {
          configName,
          phase: "extraction",
          done: p.done,
          total: p.total,
          failed: p.failed,
        } satisfies ProgressTick),
    });

    // Recompute outage from the final disk state so the done frame is authoritative.
    outageProviders = computeOutageProviders(loadCells(resultsPath), config);
  } finally {
    releaseLock({ ownerPid: lock.pid });
    runEvents.emit("done", { configName, outageProviders } satisfies DoneTick);
  }
}
