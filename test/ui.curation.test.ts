import { describe, expect, it } from "vitest";
import { curationCandidates, promoteCompetitors } from "../backend/services/curation.js";
import { dedupeExtractions } from "../backend/core/extract.js";
import type { Cell, ExtractionCell, RunConfig } from "../backend/core/types.js";
import { makeBrand, makeCitation, makeConfig, makeExtCell, makeGenCell } from "./helpers.js";

/** The exact tally cli.ts used to compute inline (the pre-refactor block). */
function oldCliTally(cells: Cell[], config: RunConfig): Array<[string, number]> {
  const curatedNames = new Set(
    [config.client, ...config.competitors].flatMap((b) => [
      b.name.toLowerCase(),
      ...b.aliases.map((a) => a.toLowerCase()),
    ]),
  );
  const latestExtractions = dedupeExtractions(
    cells.filter((c): c is ExtractionCell => c.kind === "extraction"),
  );
  const discovered = new Map<string, number>();
  for (const c of latestExtractions) {
    for (const b of c.brands ?? []) {
      if (curatedNames.has(b.toLowerCase())) continue;
      discovered.set(b, (discovered.get(b) ?? 0) + 1);
    }
  }
  return [...discovered.entries()].sort((a, b) => b[1] - a[1]);
}

describe("curationCandidates parity with the old CLI block", () => {
  const client = makeBrand("TIkit", ["Tikit Ltd"], "tikit.com");
  const config = makeConfig({ client, competitors: [makeBrand("Acme", ["Acme Corp"])] });
  const g1 = makeGenCell({ promptText: "q1" });
  const g2 = makeGenCell({ promptText: "q2" });
  const cells: Cell[] = [
    g1,
    g2,
    makeExtCell(g1, ["Globex", "Acme", "Initech"]), // Acme excluded (curated competitor)
    makeExtCell(g2, ["Globex", "TIkit", "Tikit Ltd"]), // TIkit + alias excluded (client)
  ];

  it("matches the old inline tally exactly", () => {
    const got = curationCandidates(cells, config).map((c) => [c.name, c.count] as [string, number]);
    expect(got).toEqual(oldCliTally(cells, config));
  });

  it("excludes curated names case-insensitively and counts the rest", () => {
    expect(curationCandidates(cells, config).map((c) => ({ name: c.name, count: c.count }))).toEqual([
      { name: "Globex", count: 2 },
      { name: "Initech", count: 1 },
    ]);
  });
});

describe("curationCandidates — current-prompt-set filter", () => {
  const config = makeConfig({ prompts: ["q1"] });
  const gCurrent = makeGenCell({ promptText: "q1" });
  const gOrphan = makeGenCell({ promptText: "removed-example" });
  const cells: Cell[] = [
    gCurrent,
    gOrphan,
    makeExtCell(gCurrent, ["Globex"]),
    makeExtCell(gOrphan, ["Initech"]), // joined to an orphan generation cell
  ];

  it("keeps every extraction when no prompt set is supplied (legacy behaviour)", () => {
    expect(curationCandidates(cells, config).map((c) => ({ name: c.name, count: c.count }))).toEqual([
      { name: "Globex", count: 1 },
      { name: "Initech", count: 1 },
    ]);
  });

  it("drops extractions joined to orphaned generation cells when the prompt set is supplied", () => {
    const currentPromptTexts = new Set(config.promptSet.prompts.map((p) => p.text));
    expect(
      curationCandidates(cells, config, currentPromptTexts).map((c) => ({
        name: c.name,
        count: c.count,
      })),
    ).toEqual([{ name: "Globex", count: 1 }]);
  });
});

describe("curationCandidates — R5 evidence (providers / promptIds / snippet)", () => {
  const config = makeConfig({ client: makeBrand("TIkit") });

  // A real-shaped client-roster sentence: the agency (a legit competitor) lists
  // eBay as a CLIENT — the snippet must expose that so the founder skips eBay.
  const roster =
    "Socially Powerful delivers reach for brands including eBay, Spotify, Amazon, and IKEA, and has earned repeated recognition.";
  // Same brand named by two providers under two distinct prompts.
  const gA = {
    ...makeGenCell({ provider: "openai", promptText: "q-a", responseText: roster }),
    promptId: "prompt-a",
  };
  const gB = {
    ...makeGenCell({ provider: "anthropic", promptText: "q-b", responseText: roster }),
    promptId: "prompt-b",
  };
  const cells: Cell[] = [gA, gB, makeExtCell(gA, ["eBay"]), makeExtCell(gB, ["eBay"])];

  it("joins each brand to its distinct providers, prompt ids, and a revealing snippet", () => {
    const ebay = curationCandidates(cells, config)[0]!;
    expect(ebay.name).toBe("eBay");
    expect(ebay.count).toBe(2); // count parity: one per deduped extraction cell
    expect([...ebay.providers].sort()).toEqual(["anthropic", "openai"]);
    expect([...ebay.promptIds].sort()).toEqual(["prompt-a", "prompt-b"]);
    // The snippet reveals eBay as a CLIENT of the agency, not a competitor.
    expect(ebay.exampleSnippet).toContain("brands including eBay, Spotify, Amazon, and IKEA");
  });

  it("returns an empty snippet when the extractor's name is not in the prose", () => {
    // Extractor surfaced a name the response prose does not contain verbatim.
    const g = makeGenCell({ responseText: "Nothing matching here at all." });
    const c = curationCandidates([g, makeExtCell(g, ["Globex"])], config)[0]!;
    expect(c.name).toBe("Globex");
    expect(c.exampleSnippet).toBe("");
    expect(c.providers).toEqual(["openai"]);
    expect(c.promptIds).toEqual(["p1"]);
  });

  it("brackets a mid-prose snippet with … on both sides", () => {
    const long = `${"x ".repeat(150)}Globex Corp${" y".repeat(150)}`;
    const g = makeGenCell({ responseText: long });
    const c = curationCandidates([g, makeExtCell(g, ["Globex"])], config)[0]!;
    expect(c.exampleSnippet.startsWith("…")).toBe(true);
    expect(c.exampleSnippet.endsWith("…")).toBe(true);
    expect(c.exampleSnippet).toContain("Globex");
  });
});

describe("curationCandidates — suggestedDomain (citation co-occurrence)", () => {
  const config = makeConfig({ client: makeBrand("TIkit") });

  it("suggests the most co-cited domain, normalized (lowercased, www-stripped)", () => {
    const g = makeGenCell({
      citations: [
        makeCitation("www.Globex.com"),
        makeCitation("globex.com"),
        makeCitation("reviews.example.org"),
      ],
    });
    const c = curationCandidates([g, makeExtCell(g, ["Globex"])], config)[0]!;
    expect(c.name).toBe("Globex");
    expect(c.suggestedDomain).toBe("globex.com"); // 2 hits, both normalize to globex.com
  });

  it("breaks count ties by domain ascending for determinism", () => {
    const g = makeGenCell({ citations: [makeCitation("zeta.com"), makeCitation("alpha.com")] });
    const c = curationCandidates([g, makeExtCell(g, ["Globex"])], config)[0]!;
    expect(c.suggestedDomain).toBe("alpha.com");
  });

  it("is empty when no cell naming the brand carried a citation", () => {
    const g = makeGenCell({ citations: [] });
    const c = curationCandidates([g, makeExtCell(g, ["Globex"])], config)[0]!;
    expect(c.suggestedDomain).toBe("");
  });
});

describe("promoteCompetitors", () => {
  const client = { ...makeBrand("TIkit"), industry: "legal tech" };
  const config = makeConfig({ client, competitors: [makeBrand("Existing")] });

  it("appends new competitors, dedupes input, and skips existing (case-insensitive)", () => {
    const out = promoteCompetitors(config, [
      { name: "Globex" },
      { name: "existing" },
      { name: "Globex" },
    ]);
    expect(out.competitors).toHaveLength(2); // Existing + Globex
    const added = out.competitors.find((c) => c.name === "Globex");
    expect(added).toEqual({
      name: "Globex",
      aliases: ["Globex"],
      domain: "",
      industry: "legal tech",
    });
  });

  it("stores the confirmed domain, normalized (lowercased, www-stripped)", () => {
    const out = promoteCompetitors(config, [{ name: "Globex", domain: "www.Globex.com" }]);
    expect(out.competitors.find((c) => c.name === "Globex")?.domain).toBe("globex.com");
  });

  it("keeps the first occurrence's domain when the same name is repeated", () => {
    const out = promoteCompetitors(config, [
      { name: "Globex", domain: "globex.com" },
      { name: "globex", domain: "other.com" },
    ]);
    expect(out.competitors.filter((c) => c.name.toLowerCase() === "globex")).toHaveLength(1);
    expect(out.competitors.find((c) => c.name === "Globex")?.domain).toBe("globex.com");
  });

  it("does not mutate the input config", () => {
    promoteCompetitors(config, [{ name: "Globex" }]);
    expect(config.competitors).toHaveLength(1);
  });
});
