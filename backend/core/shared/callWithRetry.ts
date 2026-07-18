/**
 * Generic retry wrapper for provider API calls (design doc, partial-failure
 * policy): RETRIES_PER_CALL retries = RETRIES_PER_CALL + 1 attempts max.
 *
 * Retryable: network errors (fetch rejects), HTTP 429, HTTP 5xx.
 * NOT retryable: HTTP 4xx other than 429 (400/401/403 fail the cell at once).
 *
 * Backoff is exponential with jitter: ~1s after the first failure, ~4s after
 * the second. `sleep` is injectable so tests run instantly.
 */

import { RETRIES_PER_CALL } from "../types.js";

/** HTTP failure carrying the response status so retry policy can branch on it. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface RetryOptions {
  /** Retries after the first attempt. Defaults to RETRIES_PER_CALL. */
  retries?: number;
  /** Base backoff in ms before jitter. Defaults to 1000 (~1s, then ~4s). */
  baseDelayMs?: number;
  /** Injectable sleep so tests can run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // Non-HTTP errors reaching here are network-level failures (fetch rejects
  // with TypeError on DNS/connection problems) — retry those.
  return true;
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? RETRIES_PER_CALL;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? realSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      // Exponential: base * 4^attempt (≈1s, ≈4s), jittered ±50%.
      const delayMs = baseDelayMs * 4 ** attempt * (0.5 + Math.random());
      await sleep(delayMs);
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies TS.
  throw lastError;
}
