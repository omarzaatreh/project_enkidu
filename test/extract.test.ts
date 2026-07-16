import { describe, expect, it } from "vitest";
import {
  buildExtractionPrompt,
  detectMention,
  parseExtractionResponse,
  tallyCompetitors,
} from "../lib/extract.js";
import { proseContainsAlias } from "../lib/shared/normalize.js";
import { makeBrand, makeExtCell, makeGenCell } from "./helpers.js";

const client = makeBrand("TIkit", ["Tikit Ltd", "tickit"], "tikit.com");

describe("detectMention — word-boundary matrix", () => {
  const cases: Array<{ text: string; expected: boolean; label: string }> = [
    { text: "We recommend TIkit for legal teams", expected: true, label: "exact name" },
    { text: "TIKIT handles matter intake well", expected: true, label: "all-caps variant" },
    { text: "tikit is a solid choice", expected: true, label: "lowercase variant" },
    { text: "Try Tikit, it's popular.", expected: true, label: "trailing comma" },
    { text: "(Tikit) tops the list!", expected: true, label: "wrapped in punctuation" },
    { text: "They chose tikit.", expected: true, label: "sentence-ending dot" },
    { text: "Teams use Tickit daily", expected: true, label: "curated misspelling alias" },
    { text: "Tikit Ltd was founded in London", expected: true, label: "multi-word alias" },
    { text: "The word tikitools appears here", expected: false, label: "prefix of longer token" },
    { text: "We evaluated atikit briefly", expected: false, label: "suffix of longer token" },
    { text: "See tikit.com for pricing", expected: true, label: "domain in prose matches domain alias" },
    { text: "Nothing relevant in this answer", expected: false, label: "no mention" },
  ];

  it.each(cases)("$label: $text -> $expected", ({ text, expected }) => {
    expect(detectMention(text, client)).toBe(expected);
  });
});

describe("proseContainsAlias — dot rule (verified against normalize.js behavior)", () => {
  it('alias "tikit" does NOT match the text "tikit.com"', () => {
    expect(proseContainsAlias("Visit tikit.com today", "tikit")).toBe(false);
  });

  it('alias "tikit" matches sentence-ending "tikit."', () => {
    expect(proseContainsAlias("They chose tikit.", "tikit")).toBe(true);
  });

  it('domain alias "tikit.com" matches "tikit.com" in prose', () => {
    expect(proseContainsAlias("Visit tikit.com today", "tikit.com")).toBe(true);
  });
});

describe("buildExtractionPrompt", () => {
  it("embeds the response text and demands a strict JSON array with [] fallback", () => {
    const prompt = buildExtractionPrompt("Clio and Smokeball are popular.");
    expect(prompt).toContain("Clio and Smokeball are popular.");
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain("Return [] if none");
  });
});

describe("parseExtractionResponse", () => {
  it("parses a bare JSON array", () => {
    expect(parseExtractionResponse('["Acme", "Beta Corp"]')).toEqual(["Acme", "Beta Corp"]);
  });

  it("parses an array inside ```json fences with surrounding prose", () => {
    const raw = 'Sure, here you go:\n```json\n["Acme", "Globex"]\n```\nLet me know!';
    expect(parseExtractionResponse(raw)).toEqual(["Acme", "Globex"]);
  });

  it("parses an array inside plain ``` fences", () => {
    expect(parseExtractionResponse('```\n["Acme"]\n```')).toEqual(["Acme"]);
  });

  it("returns [] for an empty array", () => {
    expect(parseExtractionResponse("[]")).toEqual([]);
  });

  it("throws on a junk string", () => {
    expect(() => parseExtractionResponse("no brands were mentioned")).toThrow();
  });

  it("throws on non-array JSON", () => {
    expect(() => parseExtractionResponse('{"brands": ["Acme"]}')).toThrow();
    expect(() => parseExtractionResponse('"Acme"')).toThrow();
    expect(() => parseExtractionResponse("42")).toThrow();
  });

  it("dedupes case-insensitively keeping first-seen casing", () => {
    expect(parseExtractionResponse('["Acme", "acme", "ACME", "ACME Inc"]')).toEqual([
      "Acme",
      "ACME Inc",
    ]);
  });

  it("trims entries and drops empties and non-strings", () => {
    expect(parseExtractionResponse('["  Acme  ", "", "   ", 42, null]')).toEqual(["Acme"]);
  });
});

describe("tallyCompetitors", () => {
  const clio = makeBrand("Clio", ["Clio Manage"], "clio.com");

  it("merges curated and discovered without double counting; excludes client from discovered", () => {
    const cell1 = makeGenCell({
      sampleIndex: 0,
      responseText: "Clio and Smokeball are popular with firms",
    });
    const cell2 = makeGenCell({ sampleIndex: 1, responseText: "smokeball came up again" });
    const cell3 = makeGenCell({ sampleIndex: 2, responseText: "TIkit is the best choice" });
    const extractions = [
      // "Clio" (curated) and "TIkit" (client) must be excluded from discovery.
      makeExtCell(cell1, ["Clio", "Smokeball", "TIkit"]),
      // Case-insensitive merge with first-seen casing kept.
      makeExtCell(cell2, ["smokeball"]),
    ];

    const rows = tallyCompetitors([cell1, cell2, cell3], extractions, client, [clio]);

    // Descending by mentions; ties keep insertion order (client row first).
    expect(rows).toEqual([
      { name: "Smokeball", mentions: 2, isClient: false },
      { name: "TIkit", mentions: 1, isClient: true },
      { name: "Clio", mentions: 1, isClient: false },
    ]);
  });

  it("ignores failed generation cells and failed extraction cells", () => {
    const okCell = makeGenCell({ sampleIndex: 0, responseText: "nothing notable" });
    const failedCell = makeGenCell({ sampleIndex: 1, status: "failed" });
    const extractions = [
      makeExtCell(okCell, ["GhostBrand"], "failed"), // failed extraction → ignored
      makeExtCell(failedCell, ["PhantomCorp"]), // joins a failed gen cell → ignored
    ];

    const rows = tallyCompetitors([okCell, failedCell], extractions, client, []);
    expect(rows).toEqual([{ name: "TIkit", mentions: 0, isClient: true }]);
  });

  it("caps output at client + top 5 non-client, client kept even at 0 mentions", () => {
    // Brand Bi appears in cells i..6, so B6 has 6 mentions ... B1 has 1.
    const brandNames = ["B1", "B2", "B3", "B4", "B5", "B6"];
    const cells = brandNames.map((_, i) =>
      makeGenCell({ sampleIndex: i, responseText: "generic answer, no client here" }),
    );
    const extractions = cells.map((cell, i) => makeExtCell(cell, brandNames.slice(0, i + 1)));

    const rows = tallyCompetitors(cells, extractions, client, []);

    expect(rows).toHaveLength(6); // client + 5
    const clientRow = rows.find((r) => r.isClient);
    expect(clientRow).toEqual({ name: "TIkit", mentions: 0, isClient: true });
    const nonClient = rows.filter((r) => !r.isClient).map((r) => r.name);
    expect(nonClient).toEqual(["B1", "B2", "B3", "B4", "B5"]);
    expect(rows.map((r) => r.mentions)).toEqual([6, 5, 4, 3, 2, 0]);
    // B6 (lowest count, 1 mention) is cut; only the client may sit below the cap.
    expect(rows.some((r) => r.name === "B6")).toBe(false);
  });

  it("handles empty inputs: client row alone at 0", () => {
    expect(tallyCompetitors([], [], client, [])).toEqual([
      { name: "TIkit", mentions: 0, isClient: true },
    ]);
  });
});
