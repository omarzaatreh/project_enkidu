import { describe, expect, it } from "vitest";
import { deriveFailures, deriveProgress } from "../backend/services/progress.js";
import type { ProviderProgress } from "../backend/services/progress.js";
import type { Cell, ExtractionCell } from "../backend/core/types.js";
import { makeConfig, makeExtCell, makeGenCell } from "./helpers.js";

// 1 prompt × 3 providers × 2 samples = 6 planned generation cells.
const config = makeConfig({ prompts: ["q"], samplesPerPrompt: 2 });

const oa0 = makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: 0, status: "ok" });
const oa1 = makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: 1, status: "ok" });
const an0 = makeGenCell({ promptText: "q", provider: "anthropic", model: "claude-test", sampleIndex: 0, status: "ok" });
const an1 = makeGenCell({ promptText: "q", provider: "anthropic", model: "claude-test", sampleIndex: 1, status: "failed" });

// byProvider is in enabled-provider order (Object.keys(config.models)): openai,
// anthropic, perplexity — each with 1 prompt × 2 samples = 2 planned cells.
const freshByProvider: ProviderProgress[] = [
  { provider: "openai", done: 0, total: 2, failed: 0 },
  { provider: "anthropic", done: 0, total: 2, failed: 0 },
  { provider: "perplexity", done: 0, total: 2, failed: 0 },
];
const partialByProvider: ProviderProgress[] = [
  { provider: "openai", done: 2, total: 2, failed: 0 },
  { provider: "anthropic", done: 2, total: 2, failed: 1 },
  { provider: "perplexity", done: 0, total: 2, failed: 0 },
];

describe("deriveProgress", () => {
  it("fresh run: nothing done, full generation total, no extraction targets yet", () => {
    expect(deriveProgress([], config)).toEqual({
      generation: { done: 0, total: 6, failed: 0 },
      extraction: { done: 0, total: 0, failed: 0 },
      byProvider: freshByProvider,
    });
  });

  it("partial run: counts ok + failed generations; extraction total follows ok generations", () => {
    const cells: Cell[] = [oa0, oa1, an0, an1];
    expect(deriveProgress(cells, config)).toEqual({
      generation: { done: 4, total: 6, failed: 1 },
      extraction: { done: 0, total: 3, failed: 0 },
      byProvider: partialByProvider,
    });
  });

  it("resumed run: extraction done/failed derived from ok-gen join", () => {
    const cells: Cell[] = [
      oa0,
      oa1,
      an0,
      an1,
      makeExtCell(oa0, ["X"], "ok"),
      makeExtCell(oa1, ["Y"], "ok"),
      makeExtCell(an0, [], "failed"),
    ];
    expect(deriveProgress(cells, config)).toEqual({
      generation: { done: 4, total: 6, failed: 1 },
      extraction: { done: 3, total: 3, failed: 1 },
      byProvider: partialByProvider,
    });
  });

  it("latest-extraction semantics: a newer extraction supersedes an older one per gen cell", () => {
    const older: ExtractionCell = {
      ...makeExtCell(oa0, ["X"], "ok"),
      timestamp: "2026-07-17T00:00:00.000Z",
    };
    const newer: ExtractionCell = {
      ...makeExtCell(oa0, [], "failed"),
      timestamp: "2026-07-18T00:00:00.000Z",
    };
    // Only oa0 is ok here → extraction total 1, and the latest (failed) wins.
    const single = makeConfig({ prompts: ["q"], samplesPerPrompt: 1 });
    single.models = { openai: "gpt-test" };
    expect(deriveProgress([oa0, older, newer], single)).toEqual({
      generation: { done: 1, total: 1, failed: 0 },
      extraction: { done: 1, total: 1, failed: 1 },
      byProvider: [{ provider: "openai", done: 1, total: 1, failed: 0 }],
    });
  });
});

// R7: the per-provider breakdown must let ≥2 providers stream independently and
// must match the same disk-derived generation totals.
describe("deriveProgress byProvider (multi-provider)", () => {
  it("each enabled provider gets an independent done/total/failed slice", () => {
    // openai fully done, anthropic half done with a failure, perplexity untouched.
    const px0 = makeGenCell({ promptText: "q", provider: "perplexity", model: "sonar-test", sampleIndex: 0, status: "ok" });
    const { byProvider, generation } = deriveProgress([oa0, oa1, an0, an1, px0], config);

    expect(byProvider).toEqual([
      { provider: "openai", done: 2, total: 2, failed: 0 },
      { provider: "anthropic", done: 2, total: 2, failed: 1 },
      { provider: "perplexity", done: 1, total: 2, failed: 0 },
    ]);

    // The per-provider slices sum to the top-line generation totals — a bar can
    // never disagree with the aggregate.
    const sum = (k: "done" | "total" | "failed") =>
      byProvider.reduce((n, b) => n + b[k], 0);
    expect(sum("done")).toBe(generation.done);
    expect(sum("total")).toBe(generation.total);
    expect(sum("failed")).toBe(generation.failed);
  });

  it("a disabled provider is absent from the breakdown", () => {
    const twoProviders = makeConfig({ prompts: ["q"], samplesPerPrompt: 2 });
    twoProviders.models = { openai: "gpt-test", anthropic: "claude-test" };
    const { byProvider } = deriveProgress([oa0, oa1, an0, an1], twoProviders);
    expect(byProvider.map((b) => b.provider)).toEqual(["openai", "anthropic"]);
  });
});

// R7: failures list — latest-wins so a retried-then-succeeded cell is NOT shown,
// and each failure carries its stored error TEXT (no bare "N failed").
describe("deriveFailures", () => {
  it("lists each failed generation with provider, prompt, sample, and error text", () => {
    const failures = deriveFailures([oa0, oa1, an0, an1], config);
    expect(failures).toEqual([
      {
        promptId: "p1",
        provider: "anthropic",
        sampleIndex: 1,
        error: "synthetic failure",
        timestamp: "2026-07-17T00:00:00.000Z",
      },
    ]);
  });

  it("latest wins: a cell that failed then succeeded on retry is NOT a failure", () => {
    const failedFirst = {
      ...makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: 0, status: "failed" }),
      timestamp: "2026-07-17T00:00:00.000Z",
    };
    const okRetry = {
      ...makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: 0, status: "ok" }),
      timestamp: "2026-07-18T00:00:00.000Z",
    };
    const single = makeConfig({ prompts: ["q"], samplesPerPrompt: 1 });
    single.models = { openai: "gpt-test" };
    expect(deriveFailures([failedFirst, okRetry], single)).toEqual([]);
  });

  it("ignores orphan cells from disabled providers / removed prompts", () => {
    const orphan = makeGenCell({ promptText: "removed prompt", provider: "openai", model: "gpt-test", sampleIndex: 0, status: "failed" });
    expect(deriveFailures([orphan, an1], config)).toEqual([
      {
        promptId: "p1",
        provider: "anthropic",
        sampleIndex: 1,
        error: "synthetic failure",
        timestamp: "2026-07-17T00:00:00.000Z",
      },
    ]);
  });
});

// R7 acceptance criterion 3: the SSE frame's byProvider is OPTIONAL, so an
// old-shape generation frame (no byProvider — e.g. the in-process emitter tick)
// still parses and renders. This mirrors the client's frame-merge logic without
// importing app/ (excluded from the root tsconfig).
type GenFrame = {
  phase: "generation";
  done: number;
  total: number;
  failed: number;
  byProvider?: ProviderProgress[];
};

/** The client's merge rule: keep the last known breakdown when a frame omits it. */
function mergeByProvider(
  prev: ProviderProgress[] | undefined,
  frame: GenFrame,
): ProviderProgress[] | undefined {
  return frame.byProvider ?? prev;
}

describe("ProgressEvent byProvider is optional (backward-compatible SSE contract)", () => {
  it("an old-shape frame without byProvider still parses", () => {
    const wire = '{"phase":"generation","done":3,"total":6,"failed":0}';
    const frame = JSON.parse(wire) as GenFrame;
    expect(frame.phase).toBe("generation");
    expect(frame.done).toBe(3);
    // The optional field is simply absent — no throw, no NaN.
    expect(frame.byProvider).toBeUndefined();
  });

  it("a frame without byProvider preserves the previously-streamed breakdown", () => {
    const prior: ProviderProgress[] = [
      { provider: "openai", done: 2, total: 2, failed: 0 },
      { provider: "anthropic", done: 1, total: 2, failed: 0 },
    ];
    const emitterTick = JSON.parse('{"phase":"generation","done":4,"total":6,"failed":0}') as GenFrame;
    expect(mergeByProvider(prior, emitterTick)).toBe(prior);
  });

  it("a disk-shaped frame supplies a fresh breakdown that replaces the prior one", () => {
    const prior: ProviderProgress[] = [{ provider: "openai", done: 1, total: 2, failed: 0 }];
    const diskFrame: GenFrame = {
      phase: "generation",
      done: 4,
      total: 6,
      failed: 0,
      byProvider: partialByProvider,
    };
    expect(mergeByProvider(prior, diskFrame)).toBe(partialByProvider);
  });
});
