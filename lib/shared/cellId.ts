import { createHash } from "node:crypto";

/**
 * Content-addressed cell IDs (eng review amendment 2 / OV-3).
 *
 * The ID hashes the actual prompt TEXT — not its index — so editing a prompt
 * invalidates exactly its own cells on resume: old cells stop matching and
 * the runner re-buys only what changed. Positional IDs would silently serve
 * answers to old wording under new prompts.
 */

const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);

export function generationCellId(args: {
  promptText: string;
  provider: string;
  model: string;
  groundingConfig: string;
  sampleIndex: number;
}): string {
  return sha256(
    ["gen", args.promptText, args.provider, args.model, args.groundingConfig, args.sampleIndex].join("|"),
  );
}

export function extractionCellId(args: {
  generationCellId: string;
  extractorModel: string;
}): string {
  return sha256(["ext", args.generationCellId, args.extractorModel].join("|"));
}
