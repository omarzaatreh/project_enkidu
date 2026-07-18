/**
 * Model selection via config.models keys (cheap-report mode): only enabled
 * providers run, pay, and appear in aggregates — and a results file carrying
 * cells from since-removed providers doesn't contaminate a cheaper re-render.
 */
import { describe, expect, it } from "vitest";
import type { Adapter, Cell, Provider, RunConfig } from "../backend/core/types.js";
import { enabledProviders, runGeneration } from "../backend/core/runner.js";
import { aggregate } from "../backend/core/aggregate.js";

const BASE: Omit<RunConfig, "models"> = {
  client: { name: "TIkit", aliases: ["Tikit"], domain: "tikit.com" },
  competitors: [],
  promptSet: {
    version: "v1",
    prompts: [
      { id: "p1", text: "best influencer marketing agencies 2026" },
      { id: "p2", text: "boutique creator agencies for small brands" },
    ],
  },
  samplesPerPrompt: 3,
  whiteLabel: { agencyName: "TIkit", accentColor: "#1a56db" },
  dateRange: { from: "2026-07-17", to: "2026-07-31" },
};

const mkAdapter = (provider: Provider): Adapter => async (req) => ({
  responseText: `${provider} recommends TIkit for "${req.promptText}"`,
  citations: [],
});

describe("provider selection via config.models", () => {
  it("enabledProviders reflects exactly the config's model keys", () => {
    expect(enabledProviders({ ...BASE, models: { anthropic: "claude-sonnet-5" } })).toEqual(["anthropic"]);
    expect(
      enabledProviders({ ...BASE, models: { openai: "gpt-5", anthropic: "claude-sonnet-5", perplexity: "sonar" } }),
    ).toHaveLength(3);
  });

  it("anthropic-only run calls only anthropic and buys exactly prompts × samples cells", async () => {
    const cells: Cell[] = [];
    const calls: Record<string, number> = { openai: 0, anthropic: 0, perplexity: 0 };
    const counting = (p: Provider): Adapter => async (req) => {
      calls[p] = (calls[p] ?? 0) + 1;
      return mkAdapter(p)(req);
    };
    const config: RunConfig = { ...BASE, models: { anthropic: "claude-sonnet-5" } };
    await runGeneration({
      config,
      // Other providers' adapters deliberately supplied — they must never be invoked.
      adapters: { openai: counting("openai"), anthropic: counting("anthropic"), perplexity: counting("perplexity") },
      existingCellIds: new Set(),
      append: (c) => cells.push(c),
    });
    expect(calls).toEqual({ openai: 0, anthropic: 6, perplexity: 0 }); // 2 prompts × 3 samples
    expect(cells).toHaveLength(6);
    expect(cells.every((c) => c.kind === "generation" && c.provider === "anthropic")).toBe(true);
  });

  it("throws when the config enables a provider with no adapter supplied", async () => {
    const config: RunConfig = { ...BASE, models: { openai: "gpt-5" } };
    await expect(
      runGeneration({
        config,
        adapters: { anthropic: mkAdapter("anthropic") },
        existingCellIds: new Set(),
        append: () => {},
      }),
    ).rejects.toThrow(/no adapter/);
  });

  it("aggregate over an anthropic-only config reports one model row", async () => {
    const cells: Cell[] = [];
    const config: RunConfig = { ...BASE, models: { anthropic: "claude-sonnet-5" } };
    await runGeneration({
      config,
      adapters: { anthropic: mkAdapter("anthropic") },
      existingCellIds: new Set(),
      append: (c) => cells.push(c),
    });
    const agg = aggregate(cells, config, []);
    expect(agg.perModel).toHaveLength(1);
    expect(agg.perModel[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      completedRuns: 6,
      plannedRuns: 6,
      mentionRuns: 6,
    });
    expect(agg.totalPlanned).toBe(6);
  });
});
