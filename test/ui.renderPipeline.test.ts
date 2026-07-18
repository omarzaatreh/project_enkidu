import { describe, expect, it } from "vitest";
import {
  computeOutageProviders,
  isOutage,
  providerCompletion,
  renderFromResults,
} from "../backend/services/renderPipeline.js";
import type { Cell, TrendPoint } from "../backend/core/types.js";
import { makeConfig, makeGenCell } from "./helpers.js";

function singleProviderConfig(samples: number) {
  const config = makeConfig({ prompts: ["q"], samplesPerPrompt: samples });
  config.models = { openai: "gpt-test" };
  return config;
}

describe("renderFromResults — outage guard", () => {
  it("refuses to render when a provider is below the completion threshold", () => {
    const config = singleProviderConfig(2); // planned 2, 0 ok → outage
    const result = renderFromResults({ config, cells: [], priorTrend: [] });
    expect(isOutage(result)).toBe(true);
    if (!isOutage(result)) throw new Error("expected outage");
    expect(result.outageProviders).toEqual(["openai"]);
  });

  it("renders anyway when the outage is acknowledged", () => {
    const config = singleProviderConfig(2);
    const result = renderFromResults({ config, cells: [], priorTrend: [], acknowledgeOutage: true });
    if (isOutage(result)) throw new Error("unexpected outage");
    expect(typeof result.html).toBe("string");
    expect(result.html.length).toBeGreaterThan(0);
  });
});

describe("orphaned-prompt cells (removed prompts in the append-only results file)", () => {
  // Config tracks exactly one current prompt "q" (openai, 3 samples → planned 3).
  const config = singleProviderConfig(3);
  const mention = "TIkit leads the Dubai market";

  const currentCells: Cell[] = [0, 1, 2].map((s) =>
    makeGenCell({ promptText: "q", provider: "openai", sampleIndex: s, status: "ok", responseText: mention }),
  );
  // Cells for a prompt SINCE REMOVED from the config — orphans that must not count.
  const orphanCells: Cell[] = [0, 1, 2].map((s) =>
    makeGenCell({ promptText: "removed-example", provider: "openai", sampleIndex: s, status: "ok", responseText: mention }),
  );

  it("providerCompletion counts only current-prompt-set ok cells", () => {
    expect(providerCompletion([...currentCells, ...orphanCells], config)).toEqual([
      { provider: "openai", completed: 3, planned: 3 },
    ]);
    // Control: without the orphans the count is identical.
    expect(providerCompletion(currentCells, config)).toEqual([
      { provider: "openai", completed: 3, planned: 3 },
    ]);
  });

  it("computeOutageProviders ignores orphan cells in its completion math", () => {
    // Only orphan cells present → current completion is 0/3 → outage, despite 3 ok cells on disk.
    expect(computeOutageProviders(orphanCells, config)).toEqual(["openai"]);
    // Current cells alone clear the threshold; adding orphans doesn't change that.
    expect(computeOutageProviders(currentCells, config)).toEqual([]);
    expect(computeOutageProviders([...currentCells, ...orphanCells], config)).toEqual([]);
  });

  it("renderFromResults excludes orphan cells from aggregate counts", () => {
    const withOrphans = renderFromResults({ config, cells: [...currentCells, ...orphanCells], priorTrend: [] });
    const controlOnly = renderFromResults({ config, cells: currentCells, priorTrend: [] });
    if (isOutage(withOrphans) || isOutage(controlOnly)) throw new Error("unexpected outage");

    // Methodology denominators reflect the current prompt set only (3, not 6).
    expect(withOrphans.html).toContain("3 of 3 runs completed");
    // Client mention tally is over current cells only (3 of 3, not 6 of 6).
    expect(withOrphans.html).toContain("appeared in 3 of 3 runs");
    expect(withOrphans.html).not.toContain("6 of 6");
    // The orphan-included render matches the control render byte-for-byte
    // except for the generatedAt timestamp, so orphans are fully excluded.
    const strip = (h: string): string => h.replace(/[0-9T:.Z-]{20,}/g, "");
    expect(strip(withOrphans.html)).toEqual(strip(controlOnly.html));
  });
});

describe("renderFromResults — trend merge", () => {
  // 3 ok samples for one prompt/provider → sufficient, no outage.
  const config = singleProviderConfig(3);
  const cells: Cell[] = [0, 1, 2].map((s) =>
    makeGenCell({ promptText: "q", provider: "openai", model: "gpt-test", sampleIndex: s, status: "ok" }),
  );
  // makeConfig's dateRange.to is 2026-07-17, version v1.

  it("appends the current point and keeps comparable prior points", () => {
    const priorTrend: TrendPoint[] = [
      { date: "2026-07-10", promptSetVersion: "v1", overallMentionRate: 0.5 },
    ];
    const result = renderFromResults({ config, cells, priorTrend });
    if (isOutage(result)) throw new Error("unexpected outage");
    expect(result.trend).toHaveLength(2);
    expect(result.trend.some((t) => t.date === "2026-07-17" && t.promptSetVersion === "v1")).toBe(true);
    expect(result.trend.some((t) => t.date === "2026-07-10")).toBe(true);
  });

  it("dedupes the current period on re-render (no duplicate date+version)", () => {
    const priorTrend: TrendPoint[] = [
      { date: "2026-07-17", promptSetVersion: "v1", overallMentionRate: 0.9 },
      { date: "2026-07-10", promptSetVersion: "v1", overallMentionRate: 0.5 },
      { date: "2026-07-05", promptSetVersion: "v-other", overallMentionRate: 0.3 },
    ];
    const result = renderFromResults({ config, cells, priorTrend });
    if (isOutage(result)) throw new Error("unexpected outage");
    const currentPoints = result.trend.filter(
      (t) => t.date === "2026-07-17" && t.promptSetVersion === "v1",
    );
    expect(currentPoints).toHaveLength(1);
    expect(result.trend).toHaveLength(3); // unchanged — nothing new to append
  });
});
