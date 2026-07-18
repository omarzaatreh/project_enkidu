/**
 * Config store — the UI's read/write layer over config/*.json (design decision
 * 1: the config JSON files remain the single source of truth; no parallel DB).
 *
 * Save AUTO-BUMPS promptSet.version (decision 5): the version is a content hash
 * of the prompt texts, so manual version management disappears. The bump only
 * happens when the prompt texts actually changed from what is on disk — an edit
 * that leaves prompt texts untouched (e.g. a white-label tweak) keeps the
 * stored version string verbatim, even a hand-written one like "v1".
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunConfig } from "../types.js";

/** Repo-root-relative config directory (matches the CLI + contract layout). */
export const CONFIG_DIR = "config";

/**
 * One-line summary of a config file for the list screen. Structurally identical
 * to ConfigSummary in app/lib/contract.ts (the route returns it verbatim); it is
 * duplicated here so lib/ui stays under the root tsconfig without importing app/.
 */
export interface ConfigSummary {
  name: string;
  clientName: string;
  promptCount: number;
  models: string[];
  samplesPerPrompt: number;
}

/** Result of a save: the written config plus its resolved (possibly bumped) version. */
export interface SaveResult {
  config: RunConfig;
  promptSetVersion: string;
}

/**
 * The auto-bump version for a set of prompt texts:
 *   "v-" + first 8 hex of sha256(JSON.stringify(texts))
 * Pure and deterministic — exported so tests can assert stability directly.
 */
export function promptSetHash(texts: string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(texts), "utf8").digest("hex");
  return `v-${hex.slice(0, 8)}`;
}

/** Filename (minus .json) → on-disk path. */
function configPath(name: string, dir: string): string {
  return join(dir, `${name}.json`);
}

function summarize(name: string, config: RunConfig): ConfigSummary {
  return {
    name,
    clientName: config.client.name,
    promptCount: config.promptSet.prompts.length,
    models: Object.keys(config.models),
    samplesPerPrompt: config.samplesPerPrompt,
  };
}

/** List config/*.json as summaries. Non-.json files are ignored. */
export function listConfigs(dir: string = CONFIG_DIR): ConfigSummary[] {
  if (!existsSync(dir)) return [];
  const summaries: ConfigSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    const config = JSON.parse(readFileSync(join(dir, file), "utf8")) as RunConfig;
    summaries.push(summarize(name, config));
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load config/[name].json verbatim. */
export function loadConfig(name: string, dir: string = CONFIG_DIR): RunConfig {
  return JSON.parse(readFileSync(configPath(name, dir), "utf8")) as RunConfig;
}

function textsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Save a config with prompt-version auto-bump. The caller MUST NOT set the
 * version themselves — the resolved version is computed here and returned.
 */
export function saveConfig(
  name: string,
  config: RunConfig,
  dir: string = CONFIG_DIR,
): SaveResult {
  const path = configPath(name, dir);
  const newTexts = config.promptSet.prompts.map((p) => p.text);

  let version: string;
  if (existsSync(path)) {
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as RunConfig;
    const oldTexts = onDisk.promptSet.prompts.map((p) => p.text);
    // Unchanged prompt texts keep the stored version verbatim (even "v1").
    version = textsEqual(oldTexts, newTexts) ? onDisk.promptSet.version : promptSetHash(newTexts);
  } else {
    version = promptSetHash(newTexts);
  }

  const toWrite: RunConfig = {
    ...config,
    promptSet: { ...config.promptSet, version },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(toWrite, null, 2)}\n`);
  return { config: toWrite, promptSetVersion: version };
}
