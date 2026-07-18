import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeInsights } from "../backend/core/insights.js";
import { filterToCurrentCells } from "../backend/core/cellFilter.js";
import { insightsFromResults } from "../backend/services/insights.js";
import { loadConfig } from "../backend/services/configStore.js";
import type { Cell, GenerationCell } from "../backend/core/types.js";

/** Mirror of app/lib/contract.resultsPath — avoids importing app/ (excluded from the root tsconfig). */
const resultsPath = (name: string): string => `results/${name}.jsonl`;
import { makeBrand, makeCitation, makeConfig, makeGenCell } from "./helpers.js";

const clio = makeBrand("Clio", [], "clio.com");

/** n ok cells for one (promptText × provider) group, sampleIndex 0..n-1. */
function group(
  promptText: string,
  n: number,
  each: (i: number) => Partial<Parameters<typeof makeGenCell>[0]> = () => ({}),
): GenerationCell[] {
  return Array.from({ length: n }, (_, i) =>
    makeGenCell({ promptText, sampleIndex: i, ...each(i) }),
  );
}

describe("computeInsights — mention matrix & flaky flag", () => {
  const config = makeConfig({ prompts: ["P1", "P2"], competitors: [clio], samplesPerPrompt: 5 });
  // P1 × openai: 4 ok, client in 2 of 4 (fraction 0.5 → flaky), Clio in 3 of 4.
  // P2 × openai: 3 ok, client in 0 (fraction 0 → not flaky), Clio in 2 of 3.
  const cells: Cell[] = [
    ...group("P1", 4, (i) => ({
      responseText: `${i < 2 ? "TIkit and " : ""}${i < 3 ? "Clio " : ""}are agencies`,
    })),
    ...group("P2", 3, (i) => ({
      responseText: `${i < 2 ? "Clio " : "nobody "}is named`,
    })),
  ];

  it("computes per-(prompt × provider) client and competitor fractions", () => {
    const { matrix } = computeInsights(cells, config);
    const p1 = matrix.find((m) => m.promptText === "P1");
    const p2 = matrix.find((m) => m.promptText === "P2");
    if (!p1 || !p2) throw new Error("missing matrix rows");

    expect(p1.samples).toBe(4);
    expect(p1.client.mentions).toBe(2);
    expect(p1.client.fraction).toBe(0.5);
    expect(p1.competitors[0]).toMatchObject({ name: "Clio", mentions: 3, fraction: 0.75 });

    expect(p2.samples).toBe(3);
    expect(p2.client.fraction).toBe(0);
    expect(p2.competitors[0]).toMatchObject({ name: "Clio", mentions: 2 });
  });

  it("flags only groups whose CLIENT fraction is strictly between 0 and 1", () => {
    const result = computeInsights(cells, config);
    const p1 = result.matrix.find((m) => m.promptText === "P1")!;
    const p2 = result.matrix.find((m) => m.promptText === "P2")!;
    expect(p1.flaky).toBe(true); // 0.5
    expect(p2.flaky).toBe(false); // 0
    expect(result.flakyCount).toBe(1);
  });
});

describe("computeInsights — share of voice denominators", () => {
  it("divides client mentions by client + competitor mention runs", () => {
    const config = makeConfig({ prompts: ["P1", "P2"], competitors: [clio], samplesPerPrompt: 5 });
    const cells: Cell[] = [
      ...group("P1", 4, (i) => ({
        responseText: `${i < 2 ? "TIkit and " : ""}${i < 3 ? "Clio " : ""}are agencies`,
      })),
      ...group("P2", 3, (i) => ({ responseText: `${i < 2 ? "Clio " : "nobody "}is named` })),
    ];
    const { shareOfVoice } = computeInsights(cells, config);
    // client mentions = 2, Clio mentions = 3 + 2 = 5 → 2 / (2 + 5).
    expect(shareOfVoice.overall).toMatchObject({ clientMentions: 2, totalMentions: 7 });
    expect(shareOfVoice.overall.share).toBeCloseTo(2 / 7, 10);
  });

  it("guards the zero-denominator case (no mentions anywhere → 0, never NaN)", () => {
    // Tikit's real data has zero prose mentions; a run with no client and no
    // competitor mentions must yield share 0, not NaN.
    const config = makeConfig({ prompts: ["P1"], competitors: [clio], samplesPerPrompt: 5 });
    const cells: Cell[] = group("P1", 3, () => ({ responseText: "a perfectly generic answer" }));
    const { shareOfVoice } = computeInsights(cells, config);
    expect(shareOfVoice.overall).toEqual({ clientMentions: 0, totalMentions: 0, share: 0 });
    expect(Number.isNaN(shareOfVoice.overall.share)).toBe(false);
  });

  it("zero-numerator with competitor mentions still divides cleanly", () => {
    const config = makeConfig({ prompts: ["P1"], competitors: [clio], samplesPerPrompt: 5 });
    const cells: Cell[] = group("P1", 3, () => ({ responseText: "Clio is the pick" }));
    const { shareOfVoice } = computeInsights(cells, config);
    expect(shareOfVoice.overall).toEqual({ clientMentions: 0, totalMentions: 3, share: 0 });
  });
});

describe("computeInsights — citation domain leaderboard", () => {
  it("tallies citation domains, ranks them, and flags client/competitor domains", () => {
    const config = makeConfig({ prompts: ["P1"], competitors: [clio], samplesPerPrompt: 5 });
    const cells: Cell[] = group("P1", 3, (i) => ({
      responseText: "an answer",
      citations:
        i === 0
          ? [makeCitation("byrdie.com"), makeCitation("tikit.com")]
          : i === 1
            ? [makeCitation("byrdie.com"), makeCitation("clio.com")]
            : [makeCitation("byrdie.com")],
    }));
    const { domainLeaderboard } = computeInsights(cells, config);
    const rows = domainLeaderboard.overall;
    expect(rows[0]).toMatchObject({ domain: "byrdie.com", count: 3 });
    const tikitRow = rows.find((r) => r.domain === "tikit.com");
    const clioRow = rows.find((r) => r.domain === "clio.com");
    expect(tikitRow).toMatchObject({ isClient: true, count: 1 });
    expect(clioRow).toMatchObject({ isClient: false, competitors: ["Clio"], count: 1 });
  });
});

describe("computeInsights — co-occurrence & category rollup", () => {
  it("splits competitor cells into appears-with-you vs instead-of-you", () => {
    const config = makeConfig({ prompts: ["P1"], competitors: [clio], samplesPerPrompt: 5 });
    const cells: Cell[] = group("P1", 3, (i) => ({
      responseText: i === 0 ? "TIkit and Clio" : "Clio alone",
    }));
    const { coOccurrence } = computeInsights(cells, config);
    expect(coOccurrence[0]).toEqual({ competitor: "Clio", withClient: 1, withoutClient: 2 });
  });

  it("rolls client mentions up by prompt category joined via promptText", () => {
    const config = makeConfig({ prompts: ["P1", "P2"], competitors: [clio], samplesPerPrompt: 5 });
    config.promptSet.prompts[0]!.category = "recommendation";
    config.promptSet.prompts[1]!.category = "comparison";
    const cells: Cell[] = [
      ...group("P1", 4, (i) => ({ responseText: i < 2 ? "TIkit rocks" : "nobody" })),
      ...group("P2", 2, () => ({ responseText: "nobody" })),
    ];
    const { categories } = computeInsights(cells, config);
    const rec = categories.find((c) => c.category === "recommendation");
    const cmp = categories.find((c) => c.category === "comparison");
    expect(rec).toEqual({ category: "recommendation", samples: 4, clientMentions: 2, clientMentionRate: 0.5 });
    expect(cmp).toEqual({ category: "comparison", samples: 2, clientMentions: 0, clientMentionRate: 0 });
  });
});

describe("insights — orphan / disabled-provider exclusion (mirrors renderPipeline)", () => {
  // One current prompt "q" on the single enabled provider (openai).
  const config = makeConfig({ prompts: ["q"], competitors: [clio], samplesPerPrompt: 3 });
  config.models = { openai: "gpt-test" };
  const currentCells: Cell[] = group("q", 3, () => ({ provider: "openai", responseText: "Clio wins" }));
  // Orphans: a prompt since removed AND a provider since disabled — must not count.
  const orphanCells: Cell[] = [
    ...group("removed-prompt", 3, () => ({ provider: "openai", responseText: "Clio wins" })),
    ...group("q", 3, () => ({ provider: "anthropic", responseText: "Clio wins" })),
  ];

  it("filterToCurrentCells drops orphaned-prompt and disabled-provider cells", () => {
    const kept = filterToCurrentCells([...currentCells, ...orphanCells], config).filter(
      (c): c is GenerationCell => c.kind === "generation",
    );
    expect(kept).toHaveLength(3);
    expect(kept.every((c) => c.provider === "openai" && c.promptText === "q")).toBe(true);
  });

  it("insights over the filtered set match the orphan-free control", () => {
    const withOrphans = computeInsights(
      filterToCurrentCells([...currentCells, ...orphanCells], config),
      config,
    );
    const control = computeInsights(filterToCurrentCells(currentCells, config), config);
    // Only the generatedAt timestamp differs; every analytic figure is identical.
    const strip = (r: object): string => JSON.stringify({ ...r, generatedAt: "" });
    expect(strip(withOrphans)).toEqual(strip(control));
    expect(withOrphans.totalSamples).toBe(3);
    expect(withOrphans.matrix).toHaveLength(1);
  });
});

// Real-data spot check. Skips when the (gitignored) tikit fixtures are absent so
// public CI stays green; the reviewer runs it against the real files locally.
const hasTikit = existsSync(resultsPath("tikit")) && existsSync("config/tikit.json");
describe.skipIf(!hasTikit)("insights — real results/tikit.jsonl", () => {
  const config = loadConfig("tikit");
  const insights = insightsFromResults(config, resultsPath("tikit"));

  it("computes over the current prompt set only (15 ok anthropic cells, 3 groups)", () => {
    expect(insights.totalSamples).toBe(15);
    expect(insights.matrix).toHaveLength(3);
  });

  it("sociallypowerful.com tops the citation leaderboard with 13", () => {
    expect(insights.domainLeaderboard.overall[0]).toMatchObject({
      domain: "sociallypowerful.com",
      count: 13,
    });
  });

  it("share of voice is 0 (Tikit has zero prose mentions) with a non-zero denominator", () => {
    expect(insights.shareOfVoice.overall.clientMentions).toBe(0);
    expect(insights.shareOfVoice.overall.totalMentions).toBeGreaterThan(0);
    expect(insights.shareOfVoice.overall.share).toBe(0);
    expect(insights.flakyCount).toBe(0);
  });
});
