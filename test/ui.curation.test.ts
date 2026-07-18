import { describe, expect, it } from "vitest";
import { curationCandidates, promoteCompetitors } from "../lib/ui/curation.js";
import { dedupeExtractions } from "../lib/extract.js";
import type { Cell, ExtractionCell, RunConfig } from "../lib/types.js";
import { makeBrand, makeConfig, makeExtCell, makeGenCell } from "./helpers.js";

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
    expect(curationCandidates(cells, config)).toEqual([
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
    expect(curationCandidates(cells, config)).toEqual([
      { name: "Globex", count: 1 },
      { name: "Initech", count: 1 },
    ]);
  });

  it("drops extractions joined to orphaned generation cells when the prompt set is supplied", () => {
    const currentPromptTexts = new Set(config.promptSet.prompts.map((p) => p.text));
    expect(curationCandidates(cells, config, currentPromptTexts)).toEqual([
      { name: "Globex", count: 1 },
    ]);
  });
});

describe("promoteCompetitors", () => {
  const client = { ...makeBrand("TIkit"), industry: "legal tech" };
  const config = makeConfig({ client, competitors: [makeBrand("Existing")] });

  it("appends new competitors, dedupes input, and skips existing (case-insensitive)", () => {
    const out = promoteCompetitors(config, ["Globex", "existing", "Globex"]);
    expect(out.competitors).toHaveLength(2); // Existing + Globex
    const added = out.competitors.find((c) => c.name === "Globex");
    expect(added).toEqual({
      name: "Globex",
      aliases: ["Globex"],
      domain: "",
      industry: "legal tech",
    });
  });

  it("does not mutate the input config", () => {
    promoteCompetitors(config, ["Globex"]);
    expect(config.competitors).toHaveLength(1);
  });
});
