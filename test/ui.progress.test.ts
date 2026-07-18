import { describe, expect, it } from "vitest";
import { deriveProgress } from "../lib/ui/progress.js";
import type { Cell, ExtractionCell } from "../lib/types.js";
import { makeConfig, makeExtCell, makeGenCell } from "./helpers.js";

// 1 prompt × 3 providers × 2 samples = 6 planned generation cells.
const config = makeConfig({ prompts: ["q"], samplesPerPrompt: 2 });

const oa0 = makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: 0, status: "ok" });
const oa1 = makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: 1, status: "ok" });
const an0 = makeGenCell({ promptText: "q", provider: "anthropic", model: "claude-test", sampleIndex: 0, status: "ok" });
const an1 = makeGenCell({ promptText: "q", provider: "anthropic", model: "claude-test", sampleIndex: 1, status: "failed" });

describe("deriveProgress", () => {
  it("fresh run: nothing done, full generation total, no extraction targets yet", () => {
    expect(deriveProgress([], config)).toEqual({
      generation: { done: 0, total: 6, failed: 0 },
      extraction: { done: 0, total: 0, failed: 0 },
    });
  });

  it("partial run: counts ok + failed generations; extraction total follows ok generations", () => {
    const cells: Cell[] = [oa0, oa1, an0, an1];
    expect(deriveProgress(cells, config)).toEqual({
      generation: { done: 4, total: 6, failed: 1 },
      extraction: { done: 0, total: 3, failed: 0 },
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
    });
  });
});
