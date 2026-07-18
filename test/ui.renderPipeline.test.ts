import { describe, expect, it } from "vitest";
import { isOutage, renderFromResults } from "../lib/ui/renderPipeline.js";
import type { Cell, TrendPoint } from "../lib/types.js";
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
