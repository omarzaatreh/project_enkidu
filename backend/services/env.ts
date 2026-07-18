/**
 * Server-side env loading for the cockpit (design decision 7: keys never reach
 * the browser). This is the `loadDotEnv` from cli.ts, moved into backend/services so the
 * run manager and route handlers share ONE loader — keys are read from .env
 * into process.env server-side and never serialized into any response.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Provider } from "../core/types.js";

/** Provider → the env var holding its API key. */
export const ENV_KEY: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/** Thrown before any paid work when an enabled provider's key is absent. */
export class MissingKeyError extends Error {
  constructor(public readonly envVar: string) {
    super(`${envVar} missing (.env) — required before a run can start`);
    this.name = "MissingKeyError";
  }
}

/** Load .env into process.env (existing values win). Same rules as cli.ts. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

/**
 * Resolve API keys for the given providers from process.env, throwing
 * MissingKeyError for the first absent one so a run never starts (and never
 * spends) with a missing key. Call loadDotEnv() first.
 */
export function requireProviderKeys(
  providers: Provider[],
): Partial<Record<Provider, string>> {
  const keys: Partial<Record<Provider, string>> = {};
  for (const p of providers) {
    const value = process.env[ENV_KEY[p]];
    if (!value) throw new MissingKeyError(ENV_KEY[p]);
    keys[p] = value;
  }
  return keys;
}
