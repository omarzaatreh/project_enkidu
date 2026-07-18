/**
 * Per-call USD price constants for the pre-run cost estimate (design amendment
 * 9, load-bearing decision 4: "cost estimate before every run").
 *
 * These are ROUGH ESTIMATES, not billed prices. They exist so the founder sees
 * an order-of-magnitude number next to the Run button — "~$5/report" territory,
 * per the design doc's cost derivation — not an invoice. Re-tune when model IDs
 * and provider pricing are pinned. A grounded generation call is far pricier
 * than a cheap haiku-class extraction call, hence the separate `extraction`.
 */

/** Rough USD per grounded OpenAI generation call (web-search enabled). */
export const OPENAI_PER_CALL_USD = 0.03;

/** Rough USD per grounded Anthropic generation call (web-search enabled). */
export const ANTHROPIC_PER_CALL_USD = 0.025;

/** Rough USD per Perplexity generation call (inherently search-grounded). */
export const PERPLEXITY_PER_CALL_USD = 0.01;

/** Rough USD per cheap extraction call (one haiku-class call per response). */
export const EXTRACTION_PER_CALL_USD = 0.001;

/**
 * Provider → per-call price lookup, keyed by the same provider strings used in
 * RunConfig.models. Estimate code multiplies these by planned/new call counts.
 */
export const PER_CALL_USD = {
  openai: OPENAI_PER_CALL_USD,
  anthropic: ANTHROPIC_PER_CALL_USD,
  perplexity: PERPLEXITY_PER_CALL_USD,
  extraction: EXTRACTION_PER_CALL_USD,
} as const;
