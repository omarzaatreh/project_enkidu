import { describe, expect, it } from "vitest";
import { aggregate } from "../backend/core/aggregate.js";
import type { GenerationCell, ModelStats, TrendPoint } from "../backend/core/types.js";
import { makeBrand, makeCitation, makeConfig, makeGenCell } from "./helpers.js";

const clio = makeBrand("Clio", [], "clio.com");

function statsFor(perModel: ModelStats[], provider: string): ModelStats {
  const found = perModel.find((m) => m.provider === provider);
  if (!found) throw new Error(`no stats for ${provider}`);
  return found;
}

/** n cells for one (promptText × provider) group, sampleIndex 0..n-1. */
function group(
  promptText: string,
  n: number,
  each: (i: number) => Partial<Parameters<typeof makeGenCell>[0]> = () => ({}),
): GenerationCell[] {
  return Array.from({ length: n }, (_, i) =>
    makeGenCell({ promptText, sampleIndex: i, ...each(i) }),
  );
}

describe("aggregate — honest denominators", () => {
  it("counts only ok cells in sufficient groups; insufficient groups are excluded and tallied", () => {
    const config = makeConfig({ prompts: ["P1", "P2"], samplesPerPrompt: 5 });
    const cells = [
      // P1 × openai: 4 ok + 1 failed → sufficient (>= MIN_SAMPLES_PER_CELL=3).
      ...group("P1", 5, (i) =>
        i === 4
          ? { status: "failed" as const }
          : { responseText: i < 2 ? "TIkit is great" : "no client named" },
      ),
      // P2 × openai: 2 ok + 3 failed → INSUFFICIENT: excluded from denominators,
      // even though its ok cells mention the client.
      ...group("P2", 5, (i) =>
        i < 2 ? { responseText: "TIkit again" } : { status: "failed" as const },
      ),
    ];

    const result = aggregate(cells, config, []);
    const openai = statsFor(result.perModel, "openai");

    expect(openai.completedRuns).toBe(4); // P1's ok cells only
    expect(openai.plannedRuns).toBe(10); // 2 prompts × 5 samples
    expect(openai.insufficientPrompts).toBe(1); // P2
    expect(openai.mentionRuns).toBe(2); // P2's mentions never counted

    const anthropic = statsFor(result.perModel, "anthropic");
    expect(anthropic).toMatchObject({
      completedRuns: 0,
      plannedRuns: 10,
      mentionRuns: 0,
      citedRuns: 0,
      insufficientPrompts: 0,
    });

    expect(result.totalPlanned).toBe(30); // 3 providers × 10
    expect(result.totalCompleted).toBe(4);
  });

  it("a group with exactly MIN ok samples (3 of 5) is sufficient", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 5 });
    const cells = group("P1", 5, (i) => (i < 3 ? {} : { status: "failed" as const }));
    const openai = statsFor(aggregate(cells, config, []).perModel, "openai");
    expect(openai.completedRuns).toBe(3);
    expect(openai.insufficientPrompts).toBe(0);
  });
});

describe("aggregate — PROSE-ONLY mention vs citation independence", () => {
  const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });

  it("cited-not-mentioned increments citedRuns only; mentioned-not-cited increments mentionRuns only", () => {
    const cells = group("P1", 3, (i) => {
      if (i === 0) {
        // Client domain in citation METADATA, client never named in prose.
        return {
          responseText: "Several tools exist for this workflow",
          citations: [makeCitation("tikit.com", "TIkit product page")],
        };
      }
      if (i === 1) {
        // Client named in prose, no client citation.
        return {
          responseText: "TIkit is a strong option",
          citations: [makeCitation("byrdie.com")],
        };
      }
      // Both: prose mention AND a www-prefixed client-domain citation.
      return {
        responseText: "TIkit leads the pack",
        citations: [makeCitation("www.tikit.com")],
      };
    });

    const openai = statsFor(aggregate(cells, config, []).perModel, "openai");
    expect(openai.completedRuns).toBe(3);
    // Independent labeled figures — a cell may count in both, either, or neither.
    expect(openai.mentionRuns).toBe(2); // cells 1 and 2
    expect(openai.citedRuns).toBe(2); // cells 0 and 2 (www. stripped)
    // Sanity: they overlap on cell 2, so summing them (4) would exceed completedRuns.
    expect(openai.mentionRuns + openai.citedRuns).toBeGreaterThan(openai.completedRuns);
  });
});

describe("aggregate — citationGaps", () => {
  it("collects domains from competitor-mention cells; clientCited both ways; not-cited sorts first", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const cells = group("P1", 3, (i) => {
      if (i === 0) {
        // Mentions Clio only; cites byrdie.com → clientCited false.
        return {
          responseText: "Clio is widely used",
          citations: [makeCitation("byrdie.com", "Best legal tools 2026")],
        };
      }
      if (i === 1) {
        // Mentions Clio AND the client; cites lawsites.com → clientCited true.
        return {
          responseText: "Clio and TIkit both fit mid-size firms",
          citations: [makeCitation("lawsites.com", "Practice management roundup")],
        };
      }
      return { responseText: "filler answer with no brands" };
    });

    const { citationGaps } = aggregate(cells, config, []);

    expect(citationGaps).toEqual([
      {
        domain: "byrdie.com",
        exampleTitle: "Best legal tools 2026",
        competitorsCited: ["Clio"],
        clientCited: false,
      },
      {
        domain: "lawsites.com",
        exampleTitle: "Practice management roundup",
        competitorsCited: ["Clio"],
        clientCited: true,
      },
    ]);
  });

  it("caps at 10 rows", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const manyCitations = Array.from({ length: 12 }, (_, i) => makeCitation(`site${i}.com`));
    const cells = group("P1", 3, () => ({
      responseText: "Clio remains the market leader",
      citations: manyCitations,
    }));

    const { citationGaps } = aggregate(cells, config, []);
    expect(citationGaps).toHaveLength(10);
    expect(citationGaps.every((row) => row.clientCited === false)).toBe(true);
  });

  it("zero competitors → empty gap table, no throw", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [] });
    const cells = group("P1", 3, () => ({
      responseText: "TIkit is mentioned but there are no curated competitors",
      citations: [makeCitation("byrdie.com")],
    }));

    const result = aggregate(cells, config, []);
    expect(result.citationGaps).toEqual([]);
  });
});

describe("aggregate — edge cases and trend", () => {
  it("empty cells array: zeros everywhere, client row present, trend point at 0", () => {
    const config = makeConfig({ prompts: ["P1", "P2"], samplesPerPrompt: 5 });
    const result = aggregate([], config, []);

    expect(result.perModel).toHaveLength(3);
    for (const stats of result.perModel) {
      expect(stats).toMatchObject({
        completedRuns: 0,
        plannedRuns: 10,
        mentionRuns: 0,
        citedRuns: 0,
        insufficientPrompts: 0,
      });
    }
    expect(result.totalCompleted).toBe(0);
    expect(result.competitors).toEqual([{ name: "TIkit", mentions: 0, isClient: true }]);
    expect(result.citationGaps).toEqual([]);
    // 0-completed guard: rate is 0, not NaN.
    expect(result.trend).toEqual([
      { date: "2026-07-17", promptSetVersion: "v1", overallMentionRate: 0 },
    ]);
  });

  it("zero ok cells (all failed): groups are insufficient, nothing throws", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });
    const cells = group("P1", 3, () => ({ status: "failed" as const }));
    const result = aggregate(cells, config, []);
    const openai = statsFor(result.perModel, "openai");
    expect(openai.completedRuns).toBe(0);
    expect(openai.insufficientPrompts).toBe(1);
    expect(result.trend[result.trend.length - 1]?.overallMentionRate).toBe(0);
  });

  it("client never mentioned: mentionRuns 0, rate 0", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });
    const cells = group("P1", 3, () => ({ responseText: "no brands here at all" }));
    const result = aggregate(cells, config, []);
    expect(statsFor(result.perModel, "openai").mentionRuns).toBe(0);
    expect(result.trend[0]?.overallMentionRate).toBe(0);
  });

  it("trend appends the current point after priorTrend with correct math", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 4, version: "v2" });
    const prior: TrendPoint[] = [
      { date: "2026-06-15", promptSetVersion: "v2", overallMentionRate: 0.5 },
    ];
    // 4 ok cells, 1 mentions the client → rate 0.25.
    const cells = group("P1", 4, (i) => ({
      responseText: i === 0 ? "TIkit wins" : "someone else wins",
    }));

    const { trend } = aggregate(cells, config, prior);
    expect(trend).toHaveLength(2);
    expect(trend[0]).toEqual(prior[0]);
    expect(trend[1]).toEqual({
      date: "2026-07-17",
      promptSetVersion: "v2",
      overallMentionRate: 0.25,
    });
    // priorTrend is not mutated.
    expect(prior).toHaveLength(1);
  });

  it("accepts an old-shape trend point (only the three original fields)", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });
    // Mimics a point deserialized from an old results/*.trend.json — no R4 fields.
    const oldPoint: TrendPoint = {
      date: "2026-06-01",
      promptSetVersion: "v1",
      overallMentionRate: 0.2,
    };
    const cells = group("P1", 3, () => ({ responseText: "no brands" }));
    const { trend } = aggregate(cells, config, [oldPoint]);
    expect(trend[0]).toEqual(oldPoint);
    expect(trend).toHaveLength(2);
  });
});

describe("aggregate — R4 share of voice (sufficiency-respecting)", () => {
  it("clientMentions equals Σ mentionRuns; total counts client + competitors", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const cells = group("P1", 3, (i) => {
      if (i === 0) return { responseText: "TIkit and Clio both fit" }; // client + Clio
      if (i === 1) return { responseText: "Clio is the market leader" }; // Clio only
      return { responseText: "no brands here" };
    });
    const result = aggregate(cells, config, []);
    const clientMentions = result.perModel.reduce((s, m) => s + m.mentionRuns, 0);
    expect(result.shareOfVoice).toEqual({
      clientMentions: 1,
      totalMentions: 3, // 1 client + 2 Clio
      share: 1 / 3,
    });
    expect(result.shareOfVoice?.clientMentions).toBe(clientMentions);
  });

  it("share is 0 (never NaN) when no brand is named", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const cells = group("P1", 3, () => ({ responseText: "nothing relevant" }));
    const result = aggregate(cells, config, []);
    expect(result.shareOfVoice).toEqual({ clientMentions: 0, totalMentions: 0, share: 0 });
  });

  it("EXCLUDES insufficient groups from the SoV totals", () => {
    const config = makeConfig({ prompts: ["P1", "P2"], samplesPerPrompt: 5, competitors: [clio] });
    const cells = [
      // P1 sufficient: 3 ok, 1 mentions client.
      ...group("P1", 5, (i) =>
        i < 3 ? { responseText: i === 0 ? "TIkit wins" : "Clio wins" } : { status: "failed" as const },
      ),
      // P2 insufficient: 2 ok that DO mention the client — must not count.
      ...group("P2", 5, (i) =>
        i < 2 ? { responseText: "TIkit again" } : { status: "failed" as const },
      ),
    ];
    const result = aggregate(cells, config, []);
    // Only P1's 3 ok cells count: 1 client + 2 Clio.
    expect(result.shareOfVoice).toEqual({ clientMentions: 1, totalMentions: 3, share: 1 / 3 });
  });
});

describe("aggregate — R4 source leaderboard (unique runs per domain)", () => {
  it("counts each domain at most once per run and flags the client domain", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const cells = group("P1", 3, (i) => {
      if (i === 0) {
        // byrdie cited TWICE in one run → counts once; client domain also cited.
        return {
          responseText: "answer",
          citations: [makeCitation("byrdie.com"), makeCitation("byrdie.com"), makeCitation("tikit.com")],
        };
      }
      if (i === 1) {
        // www. prefix normalizes to the same byrdie.com.
        return { responseText: "answer", citations: [makeCitation("www.byrdie.com")] };
      }
      return { responseText: "answer", citations: [] };
    });
    const result = aggregate(cells, config, []);
    expect(result.sources?.completedRuns).toBe(3);
    expect(result.sources?.rows).toEqual([
      { domain: "byrdie.com", runsCiting: 2, clientCited: false }, // runs 0 and 1, not 3
      { domain: "tikit.com", runsCiting: 1, clientCited: true }, // client domain flagged
    ]);
  });

  it("caps at 8 rows", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });
    const manyCitations = Array.from({ length: 12 }, (_, i) => makeCitation(`site${i}.com`));
    const cells = group("P1", 3, () => ({ responseText: "answer", citations: manyCitations }));
    const result = aggregate(cells, config, []);
    expect(result.sources?.rows).toHaveLength(8);
  });
});

describe("aggregate — R4 pull-quote", () => {
  it("picks the sentence with the client's first mention", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });
    const cells = group("P1", 3, (i) => ({
      responseText:
        i === 0
          ? "Many tools exist. TIkit is a strong option for mid-size firms. Others vary."
          : "no brands",
    }));
    const result = aggregate(cells, config, []);
    expect(result.pullQuote).toEqual({
      text: "TIkit is a strong option for mid-size firms.",
      provider: "openai",
      brand: "TIkit",
      isClient: true,
    });
  });

  it("falls back to the top competitor when the client is never named", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const cells = group("P1", 3, () => ({
      responseText: "The market leader is Clio by a wide margin. It dominates.",
    }));
    const result = aggregate(cells, config, []);
    expect(result.pullQuote?.isClient).toBe(false);
    expect(result.pullQuote?.brand).toBe("Clio");
    expect(result.pullQuote?.text).toBe("The market leader is Clio by a wide margin.");
  });

  it("strips markdown emphasis/heading markers from the quoted sentence", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3 });
    const cells = group("P1", 3, () => ({
      responseText: "## Top pick\n\n**TIkit** — a great fit for legal teams.",
    }));
    const result = aggregate(cells, config, []);
    expect(result.pullQuote?.text).toBe("TIkit — a great fit for legal teams.");
  });

  it("is undefined when no brand is named anywhere", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 3, competitors: [clio] });
    const cells = group("P1", 3, () => ({ responseText: "nothing to see" }));
    const result = aggregate(cells, config, []);
    expect(result.pullQuote).toBeUndefined();
  });
});

describe("aggregate — R4 per-prompt appendix", () => {
  it("reports per-provider mentioned-of-samples per prompt", () => {
    const config = makeConfig({ prompts: ["P1", "P2"], samplesPerPrompt: 3 });
    const cells = [
      // P1 × openai: 3 ok, 2 mention the client.
      ...group("P1", 3, (i) => ({
        provider: "openai" as const,
        responseText: i < 2 ? "TIkit is great" : "someone else",
      })),
      // P1 × anthropic: 3 ok, 0 mention the client.
      ...group("P1", 3, (i) => ({
        provider: "anthropic" as const,
        sampleIndex: i,
        responseText: "no client here",
      })),
    ];
    const result = aggregate(cells, config, []);
    // Only P1 has sufficient groups; P2 has none → single appendix row.
    expect(result.promptBreakdown).toHaveLength(1);
    const row = result.promptBreakdown![0]!;
    expect(row.promptText).toBe("P1");
    expect(row.cells).toEqual([
      { provider: "openai", samples: 3, mentioned: 2 },
      { provider: "anthropic", samples: 3, mentioned: 0 },
    ]);
  });

  it("excludes insufficient prompt groups from the appendix", () => {
    const config = makeConfig({ prompts: ["P1"], samplesPerPrompt: 5 });
    // 2 ok + 3 failed → insufficient → no appendix row.
    const cells = group("P1", 5, (i) => (i < 2 ? {} : { status: "failed" as const }));
    const result = aggregate(cells, config, []);
    expect(result.promptBreakdown).toEqual([]);
  });
});
