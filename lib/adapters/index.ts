/** Adapter registry keyed by Provider (consumed by the runner). */

import type { Adapter, Provider } from "../types.js";
import { makeOpenAIAdapter } from "./openai.js";
import { makeAnthropicAdapter } from "./anthropic.js";
import { makePerplexityAdapter } from "./perplexity.js";

/** Builds adapters only for the providers whose keys are supplied — the set
 * of enabled providers is driven by RunConfig.models, and cli.ts only
 * demands the API keys those providers need. */
export function makeAdapters(
  keys: Partial<Record<Provider, string>>,
): Partial<Record<Provider, Adapter>> {
  const adapters: Partial<Record<Provider, Adapter>> = {};
  if (keys.openai) adapters.openai = makeOpenAIAdapter(keys.openai);
  if (keys.anthropic) adapters.anthropic = makeAnthropicAdapter(keys.anthropic);
  if (keys.perplexity) adapters.perplexity = makePerplexityAdapter(keys.perplexity);
  return adapters;
}
