/**
 * Crash-resume idempotency + edited-prompt invalidation (eng review 1A, OV-3,
 * D10). Exercises the REAL runner + extract + aggregate chain with mock
 * adapters — no network, no file I/O (cells collect in arrays exactly as
 * cli.ts appends them to results.jsonl).
 *
 * The trust-critical property: a run that crashes at cell N and resumes must
 * produce aggregates BYTE-IDENTICAL to an uninterrupted run — no double-spend,
 * no double-count.
 */
import { describe, expect, it } from "vitest";
import type {
  Adapter,
  AdapterRequest,
  Cell,
  GenerationCell,
  Provider,
  RunConfig,
} from "../lib/types.js";
import { runGeneration, GROUNDING_CONFIG } from "../lib/runner.js";
import { generationCellId } from "../lib/shared/cellId.js";
import { aggregate } from "../lib/aggregate.js";

const CONFIG: RunConfig = {
  client: { name: "TIkit", aliases: ["Tikit"], domain: "tikit.com" },
  competitors: [{ name: "Obviously", aliases: [], domain: "obviously.com" }],
  promptSet: {
    version: "v1",
    prompts: [
      { id: "p1", text: "best influencer marketing agencies 2026" },
      { id: "p2", text: "boutique creator agencies for small brands" },
    ],
  },
  models: { openai: "gpt-5", anthropic: "claude-sonnet-5", perplexity: "sonar" },
  samplesPerPrompt: 5,
  whiteLabel: { agencyName: "TIkit", accentColor: "#1a56db" },
  dateRange: { from: "2026-07-17", to: "2026-07-31" },
};

/** Deterministic mock: answer depends only on (promptText, model) — like a
 * fixed-seed provider — so interrupted and uninterrupted runs are comparable. */
function makeDeterministicAdapter(provider: Provider): Adapter {
  return async (req: AdapterRequest) => ({
    responseText: `${provider} says: Obviously and TIkit are strong for "${req.promptText}" (${req.model}).`,
    citations: [{ url: `https://rankings.example/${provider}`, domain: "rankings.example" }],
  });
}

/** Wraps an adapter to throw (simulated crash/outage) after N successful calls. */
function makeCrashingAdapter(inner: Adapter, crashAfter: number): Adapter {
  let calls = 0;
  return async (req) => {
    calls++;
    if (calls > crashAfter) throw new Error("simulated provider outage");
    return inner(req);
  };
}

function adapterSet(fn: (p: Provider) => Adapter): Record<Provider, Adapter> {
  return { openai: fn("openai"), anthropic: fn("anthropic"), perplexity: fn("perplexity") };
}

function okCells(cells: Cell[]): GenerationCell[] {
  return cells.filter((c): c is GenerationCell => c.kind === "generation" && c.status === "ok");
}

function resumeState(cells: Cell[]) {
  const ok = okCells(cells);
  const existingCellIds = new Set(ok.map((c) => c.cellId));
  const existingOkByProvider = { openai: 0, anthropic: 0, perplexity: 0 } as Record<Provider, number>;
  for (const c of ok) existingOkByProvider[c.provider]++;
  return { existingCellIds, existingOkByProvider };
}

/** Strip per-run noise (cell timestamps AND the aggregate's generatedAt stamp)
 * so the comparison covers exactly the numbers a report reader sees. */
function comparable(cells: Cell[]) {
  const agg = aggregate(
    cells.map((c) => ({ ...c, timestamp: "T" })),
    CONFIG,
    [],
  );
  return { ...agg, generatedAt: "T" };
}

describe("crash-resume idempotency", () => {
  it("resume after mid-run crash yields aggregates byte-identical to an uninterrupted run", async () => {
    // Control: uninterrupted run.
    const controlCells: Cell[] = [];
    await runGeneration({
      config: CONFIG,
      adapters: adapterSet(makeDeterministicAdapter),
      existingCellIds: new Set(),
      append: (c) => controlCells.push(c),
    });

    // Crash run: every provider dies after 4 successful calls.
    const crashedCells: Cell[] = [];
    await runGeneration({
      config: CONFIG,
      adapters: adapterSet((p) => makeCrashingAdapter(makeDeterministicAdapter(p), 4)),
      existingCellIds: new Set(),
      append: (c) => crashedCells.push(c),
    });
    expect(okCells(crashedCells).length).toBe(12); // 4 ok × 3 providers
    expect(crashedCells.filter((c) => c.kind === "generation" && c.status === "failed").length).toBeGreaterThan(0);

    // Resume with healthy adapters — only missing cells run; failed cells retry.
    const { existingCellIds, existingOkByProvider } = resumeState(crashedCells);
    const resumedCells: Cell[] = [...okCells(crashedCells)]; // cli.ts keeps ok cells; failed are retried
    let callsDuringResume = 0;
    await runGeneration({
      config: CONFIG,
      adapters: adapterSet((p) => {
        const inner = makeDeterministicAdapter(p);
        return async (req) => {
          callsDuringResume++;
          return inner(req);
        };
      }),
      existingCellIds,
      existingOkByProvider,
      append: (c) => resumedCells.push(c),
    });

    const totalPlanned = 2 * 5 * 3; // prompts × samples × providers
    // No double-spend: resume bought exactly the missing cells.
    expect(callsDuringResume).toBe(totalPlanned - 12);
    // No double-count: exactly one ok cell per planned (prompt × provider × sample).
    const ids = okCells(resumedCells).map((c) => c.cellId);
    expect(ids.length).toBe(totalPlanned);
    expect(new Set(ids).size).toBe(totalPlanned);
    // The product's promise: identical aggregates.
    expect(JSON.stringify(comparable(resumedCells))).toBe(JSON.stringify(comparable(controlCells)));
  });

  it("a fully-resumed run makes zero API calls", async () => {
    const cells: Cell[] = [];
    await runGeneration({
      config: CONFIG,
      adapters: adapterSet(makeDeterministicAdapter),
      existingCellIds: new Set(),
      append: (c) => cells.push(c),
    });
    const { existingCellIds, existingOkByProvider } = resumeState(cells);
    let calls = 0;
    await runGeneration({
      config: CONFIG,
      adapters: adapterSet(() => async () => {
        calls++;
        throw new Error("must not be called");
      }),
      existingCellIds,
      existingOkByProvider,
      append: () => {
        throw new Error("must not append");
      },
    });
    expect(calls).toBe(0);
  });
});

describe("edited-prompt invalidation (content-hash cell IDs)", () => {
  it("editing one prompt re-runs only that prompt's cells; untouched cells stay cached", async () => {
    const cells: Cell[] = [];
    await runGeneration({
      config: CONFIG,
      adapters: adapterSet(makeDeterministicAdapter),
      existingCellIds: new Set(),
      append: (c) => cells.push(c),
    });

    const edited: RunConfig = {
      ...CONFIG,
      promptSet: {
        version: "v2", // versioning rule: any edit bumps the version
        prompts: [
          CONFIG.promptSet.prompts[0]!,
          { id: "p2", text: "boutique creator agencies for small brands in Europe" }, // edited
        ],
      },
    };

    const { existingCellIds, existingOkByProvider } = resumeState(cells);
    const promptsCalled = new Set<string>();
    await runGeneration({
      config: edited,
      adapters: adapterSet((p) => {
        const inner = makeDeterministicAdapter(p);
        return async (req) => {
          promptsCalled.add(req.promptText);
          return inner(req);
        };
      }),
      existingCellIds,
      existingOkByProvider,
      append: (c) => cells.push(c),
    });

    // Only the edited prompt re-ran — the old wording's cells never serve the new wording.
    expect(promptsCalled).toEqual(new Set(["boutique creator agencies for small brands in Europe"]));
    // And its new cells carry IDs distinct from the old prompt's cells.
    const oldId = generationCellId({
      promptText: "boutique creator agencies for small brands",
      provider: "openai",
      model: "gpt-5",
      groundingConfig: GROUNDING_CONFIG,
      sampleIndex: 0,
    });
    const newId = generationCellId({
      promptText: "boutique creator agencies for small brands in Europe",
      provider: "openai",
      model: "gpt-5",
      groundingConfig: GROUNDING_CONFIG,
      sampleIndex: 0,
    });
    expect(oldId).not.toBe(newId);
  });
});
