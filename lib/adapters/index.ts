/** Adapter registry keyed by Provider (consumed by the runner). */

import type { Adapter, Provider } from "../types.js";
import { makeOpenAIAdapter } from "./openai.js";
import { makeAnthropicAdapter } from "./anthropic.js";
import { makePerplexityAdapter } from "./perplexity.js";

export function makeAdapters(keys: {
  openai: string;
  anthropic: string;
  perplexity: string;
}): Record<Provider, Adapter> {
  return {
    openai: makeOpenAIAdapter(keys.openai),
    anthropic: makeAnthropicAdapter(keys.anthropic),
    perplexity: makePerplexityAdapter(keys.perplexity),
  };
}
