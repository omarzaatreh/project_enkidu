import { describe, expect, it } from "vitest";
import { htmlEscape, renderReport } from "../backend/core/render.js";
import type {
  AggregateResult,
  BrandConfig,
  ModelStats,
  RunConfig,
} from "../backend/core/types.js";

// ---------- Fixture helpers ----------

function makeBrand(overrides: Partial<BrandConfig> = {}): BrandConfig {
  return {
    name: "TIkit",
    aliases: ["TIkit", "Tikit App"],
    domain: "tikit.com",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    client: makeBrand(),
    competitors: [
      makeBrand({ name: "Glossier", domain: "glossier.com" }),
      makeBrand({ name: "Fenty Beauty", domain: "fentybeauty.com" }),
    ],
    promptSet: {
      version: "v1.3.0",
      prompts: [
        { id: "best-influencer-agencies-uk", text: "What are the best influencer agencies in the UK?" },
      ],
    },
    models: {
      openai: "gpt-4o-search-preview-2025-03-11",
      anthropic: "claude-sonnet-4-5-20250929",
      perplexity: "sonar-pro",
    },
    samplesPerPrompt: 5,
    whiteLabel: {
      agencyName: "Northwind Digital",
      accentColor: "#b4552d",
    },
    dateRange: { from: "2026-06-01", to: "2026-06-30" },
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelStats> = {}): ModelStats {
  return {
    provider: "openai",
    model: "gpt-4o-search-preview-2025-03-11",
    completedRuns: 10,
    plannedRuns: 10,
    mentionRuns: 7,
    citedRuns: 3,
    insufficientPrompts: 0,
    ...overrides,
  };
}

function makeAgg(overrides: Partial<AggregateResult> = {}): AggregateResult {
  return {
    client: makeBrand(),
    perModel: [
      makeModel(),
      makeModel({
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        completedRuns: 8,
        plannedRuns: 10,
        mentionRuns: 2,
        citedRuns: 1,
        insufficientPrompts: 1,
      }),
      makeModel({
        provider: "perplexity",
        model: "sonar-pro",
        completedRuns: 10,
        plannedRuns: 10,
        mentionRuns: 5,
        citedRuns: 5,
      }),
    ],
    competitors: [
      { name: "Glossier", mentions: 12, isClient: false },
      { name: "TIkit", mentions: 4, isClient: true },
      { name: "Fenty Beauty", mentions: 9, isClient: false },
    ],
    citationGaps: [
      {
        domain: "byrdie.com",
        exampleTitle: "The 12 Best Beauty Brands of 2026",
        competitorsCited: ["Glossier", "Fenty Beauty"],
        clientCited: false,
      },
      {
        domain: "allure.com",
        competitorsCited: ["Glossier"],
        clientCited: true,
      },
    ],
    trend: [
      { date: "2026-05-31", promptSetVersion: "v1.3.0", overallMentionRate: 0.31 },
      { date: "2026-06-30", promptSetVersion: "v1.3.0", overallMentionRate: 0.5 },
    ],
    promptSetVersion: "v1.3.0",
    totalPlanned: 30,
    totalCompleted: 28,
    generatedAt: "2026-07-01T09:00:00.000Z",
    shareOfVoice: { clientMentions: 14, totalMentions: 35, share: 14 / 35 },
    sources: {
      completedRuns: 28,
      rows: [
        { domain: "byrdie.com", runsCiting: 20, clientCited: false },
        { domain: "allure.com", runsCiting: 14, clientCited: false },
        { domain: "tikit.com", runsCiting: 5, clientCited: true },
      ],
    },
    pullQuote: {
      text: "TIkit is a strong option for mid-size brands.",
      provider: "openai",
      brand: "TIkit",
      isClient: true,
    },
    promptBreakdown: [
      {
        promptText: "What are the best influencer agencies in the UK?",
        cells: [
          { provider: "openai", samples: 5, mentioned: 3 },
          { provider: "anthropic", samples: 4, mentioned: 0 },
          { provider: "perplexity", samples: 5, mentioned: 2 },
        ],
      },
    ],
    ...overrides,
  };
}

/** Every rendered state must be free of leaked JS junk values. */
function expectClean(html: string): void {
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("NaN");
}

// ---------- Tests ----------

describe("renderReport — full state", () => {
  const html = renderReport(makeAgg(), makeConfig());

  it("is a complete document with noindex meta and title", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain("<title>AI Visibility Report — TIkit</title>");
    expectClean(html);
  });

  it("renders both labeled figures per model with correct numbers", () => {
    // openai: 7/10 mentions, 3/10 cited
    expect(html).toContain("ChatGPT");
    expect(html).toContain("70%");
    expect(html).toContain("appeared in 7 of 10 runs");
    expect(html).toContain("Cited as a source:</span> 30% (3 of 10)");
    // anthropic: 2/8 mentions = 25%, 1/8 cited = 13%
    expect(html).toContain("Claude");
    expect(html).toContain("25%");
    expect(html).toContain("appeared in 2 of 8 runs");
    expect(html).toContain("Cited as a source:</span> 13% (1 of 8)");
    // perplexity: 5/10 both
    expect(html).toContain("Perplexity");
    expect(html).toContain("appeared in 5 of 10 runs");
    expect(html).toContain("Cited as a source:</span> 50% (5 of 10)");
  });

  it("preserves competitor order and highlights the client with (you)", () => {
    const glossier = html.indexOf("Glossier");
    const fenty = html.indexOf("Fenty Beauty");
    expect(glossier).toBeGreaterThan(-1);
    expect(fenty).toBeGreaterThan(-1);
    expect(glossier).toBeLessThan(fenty);
    expect(html).toContain("(you)");
    expect(html).toContain("bar-you");
  });

  it("emphasizes clientCited=false gap rows", () => {
    expect(html).toContain("gap-miss");
    expect(html).toContain("<strong>No</strong>");
    expect(html).toContain("byrdie.com");
    expect(html).toContain("allure.com");
    expect(html).toContain("Glossier, Fenty Beauty");
    // the clientCited=true row renders a plain Yes
    expect(html).toContain(">Yes</td>");
  });

  it("renders the trend SVG with both points and date labels", () => {
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
    expect(html).toContain("2026-05-31");
    expect(html).toContain("2026-06-30");
    expect(html).toContain("31%");
    expect(html).toContain("50%");
  });

  it("methodology lists pinned model IDs, grounding, versions, and caveats", () => {
    expect(html).toContain("gpt-4o-search-preview-2025-03-11 (web search grounded)");
    expect(html).toContain("claude-sonnet-4-5-20250929 (web search grounded)");
    expect(html).toContain("sonar-pro (web search grounded)");
    expect(html).toContain("Prompt set version v1.3.0");
    expect(html).toContain("5 samples per prompt");
    expect(html).toContain("28 of 30 runs completed");
    expect(html).toContain(
      "AI answers vary between runs; percentages report observed frequency across samples, not a guarantee of any single answer",
    );
    expect(html).toContain(
      "Measured via provider APIs with web search enabled; consumer apps may differ",
    );
  });

  it("reports per-model insufficientPrompts when nonzero", () => {
    expect(html).toContain("Prompts excluded for insufficient samples");
    expect(html).toContain("Claude (claude-sonnet-4-5-20250929): 1");
    // openai has 0 insufficient prompts, so it must not appear in that line
    expect(html).not.toContain("ChatGPT (gpt-4o-search-preview-2025-03-11): 0");
  });

  it("includes a print stylesheet", () => {
    expect(html).toContain("@media print");
  });
});

describe("renderReport — first-run state (single trend point)", () => {
  const html = renderReport(
    makeAgg({
      trend: [
        { date: "2026-06-30", promptSetVersion: "v1.3.0", overallMentionRate: 0.4 },
      ],
    }),
    makeConfig(),
  );

  it("omits the entire trend block", () => {
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<polyline");
    expect(html).not.toContain("Mention rate over time");
    expectClean(html);
  });
});

describe("renderReport — zero-mention state", () => {
  const html = renderReport(
    makeAgg({
      perModel: [
        makeModel({ mentionRuns: 0, citedRuns: 0 }),
        makeModel({
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
          mentionRuns: 0,
          citedRuns: 0,
        }),
        makeModel({ provider: "perplexity", model: "sonar-pro", mentionRuns: 0, citedRuns: 0 }),
      ],
    }),
    makeConfig(),
  );

  it("inserts the framing paragraph after the hero row", () => {
    expect(html).toContain(
      "TIkit did not appear in AI answers during this period",
    );
    expect(html).toContain(
      "the sections below show who appears instead and where AI systems source their information",
    );
  });

  it("hero shows 0% and all major sections remain", () => {
    expect(html).toContain("0%");
    expect(html).toContain("appeared in 0 of 10 runs");
    expect(html).toContain("Who appears instead of you");
    expect(html).toContain("Where the AIs get their information");
    expect(html).toContain("Methodology");
    expectClean(html);
  });
});

describe("renderReport — empty competitors and empty gaps", () => {
  const html = renderReport(
    makeAgg({ competitors: [], citationGaps: [] }),
    makeConfig(),
  );

  it("renders empty-state sentences instead of bars and table", () => {
    expect(html).toContain(
      "No competitor brands were detected in AI answers during this period.",
    );
    expect(html).toContain(
      "No citation gaps were identified during this period.",
    );
    expect(html).not.toContain('<div class="bar-row');
    // The competitor bar chart and the citation-gap table both collapse to
    // their empty states. "Competitors cited there" is the gap table's unique
    // header; R4's source/appendix tables are unaffected and may remain.
    expect(html).not.toContain("Competitors cited there");
  });

  it("contains neither undefined nor NaN", () => {
    expectClean(html);
  });

  it("treats a lone client bar at 0 mentions as empty too", () => {
    const lone = renderReport(
      makeAgg({
        competitors: [{ name: "TIkit", mentions: 0, isClient: true }],
        citationGaps: [],
      }),
      makeConfig(),
    );
    expect(lone).toContain(
      "No competitor brands were detected in AI answers during this period.",
    );
    expect(lone).not.toContain('<div class="bar-row');
    expectClean(lone);
  });
});

describe("renderReport — model with zero completed runs", () => {
  const html = renderReport(
    makeAgg({
      perModel: [
        makeModel(),
        makeModel({
          provider: "perplexity",
          model: "sonar-pro",
          completedRuns: 0,
          plannedRuns: 10,
          mentionRuns: 0,
          citedRuns: 0,
        }),
      ],
    }),
    makeConfig(),
  );

  it('renders "—" instead of a percentage, never NaN', () => {
    expect(html).toContain(">—</div>");
    expect(html).toContain("appeared in 0 of 0 runs");
    expect(html).toContain("Cited as a source:</span> — (0 of 0)");
    expectClean(html);
  });
});

describe("renderReport — R4 share-of-voice hero line", () => {
  it("renders the SoV line with the total mentions and rounded share", () => {
    const html = renderReport(makeAgg(), makeConfig());
    // 14 / 35 = 40%
    expect(html).toContain("sov-line");
    expect(html).toContain("Of <strong>35</strong> brand mentions AI made in your category");
    expect(html).toContain("you received <strong>40%</strong>");
    expectClean(html);
  });

  it("zero-mention: SoV is 0% (never NaN) with real totals present", () => {
    const html = renderReport(
      makeAgg({ shareOfVoice: { clientMentions: 0, totalMentions: 39, share: 0 } }),
      makeConfig(),
    );
    expect(html).toContain("Of <strong>39</strong> brand mentions");
    expect(html).toContain("you received <strong>0%</strong>");
    expectClean(html);
  });

  it("empty-state when no brand is named anywhere (totalMentions 0)", () => {
    const html = renderReport(
      makeAgg({ shareOfVoice: { clientMentions: 0, totalMentions: 0, share: 0 } }),
      makeConfig(),
    );
    expect(html).toContain("AI named no brands in your category during this period");
    expect(html).not.toContain("brand mentions AI made in your category");
    expectClean(html);
  });

  it("omits the SoV line entirely for old-shape aggregates without the field", () => {
    const html = renderReport(makeAgg({ shareOfVoice: undefined }), makeConfig());
    expect(html).not.toContain('<p class="sov-line');
    expectClean(html);
  });
});

describe("renderReport — R4 source leaderboard", () => {
  const html = renderReport(makeAgg(), makeConfig());

  it("renders the section with each domain and its % of runs", () => {
    expect(html).toContain("Where AI systems get their information");
    expect(html).toContain("byrdie.com");
    // 20 of 28 = 71%
    expect(html).toContain("71% <span class=\"source-runs\">(20 of 28 runs)</span>");
    // 14 of 28 = 50%
    expect(html).toContain("50% <span class=\"source-runs\">(14 of 28 runs)</span>");
  });

  it("tints the client-cited row with the accent (source-you)", () => {
    expect(html).toContain("source-you");
    expect(html).toContain("tikit.com");
    // client-cited row carries the (you) tag
    const youIdx = html.indexOf("source-you");
    expect(youIdx).toBeGreaterThan(-1);
  });

  it("empty-state when no sources were cited", () => {
    const empty = renderReport(
      makeAgg({ sources: { completedRuns: 10, rows: [] } }),
      makeConfig(),
    );
    expect(empty).toContain("No sources were cited in AI answers during this period.");
    expect(empty).not.toContain("source-row");
    expectClean(empty);
  });

  it("omits nothing but shows empty-state for old-shape aggregates without the field", () => {
    const old = renderReport(makeAgg({ sources: undefined }), makeConfig());
    expect(old).toContain("No sources were cited in AI answers during this period.");
    expectClean(old);
  });
});

describe("renderReport — R4 pull-quote", () => {
  it("renders a blockquote with client attribution when the client is quoted", () => {
    const html = renderReport(makeAgg(), makeConfig());
    expect(html).toContain("<blockquote>");
    expect(html).toContain("TIkit is a strong option for mid-size brands.");
    expect(html).toContain("ChatGPT on TIkit");
  });

  it("falls back to the top competitor with a 'not named' attribution", () => {
    const html = renderReport(
      makeAgg({
        pullQuote: {
          text: "Socially Powerful is a global influencer marketing agency.",
          provider: "anthropic",
          brand: "Socially Powerful",
          isClient: false,
        },
      }),
      makeConfig(),
    );
    expect(html).toContain("Socially Powerful is a global influencer marketing agency.");
    expect(html).toContain("Claude on Socially Powerful");
    expect(html).toContain("TIkit was not named");
  });

  it("htmlEscapes the pull-quote text", () => {
    const html = renderReport(
      makeAgg({
        pullQuote: {
          text: 'TIkit <b>"wins"</b> & leads',
          provider: "openai",
          brand: "TIkit",
          isClient: true,
        },
      }),
      makeConfig(),
    );
    expect(html).toContain("TIkit &lt;b&gt;&quot;wins&quot;&lt;/b&gt; &amp; leads");
    expect(html).not.toContain("<b>\"wins\"</b>");
    expectClean(html);
  });

  it("omits the pull-quote section when there is no quote (old-shape / no brand named)", () => {
    const html = renderReport(makeAgg({ pullQuote: undefined }), makeConfig());
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain('class="pull-quote"');
    expectClean(html);
  });
});

describe("renderReport — R4 per-prompt appendix", () => {
  const html = renderReport(makeAgg(), makeConfig());

  it("renders a row per prompt with per-provider x-of-n cells", () => {
    expect(html).toContain("Prompt-by-prompt breakdown");
    expect(html).toContain("What are the best influencer agencies in the UK?");
    expect(html).toContain("3 of 5");
    expect(html).toContain("2 of 5");
  });

  it("tints losing (0-mention) cells as a miss", () => {
    expect(html).toContain("appendix-miss");
    expect(html).toContain(">0 of 4</td>");
  });

  it("empty-state when no prompt had enough samples", () => {
    const empty = renderReport(makeAgg({ promptBreakdown: [] }), makeConfig());
    expect(empty).toContain("No prompts had enough completed samples to break down");
    expectClean(empty);
  });

  it("shows empty-state for old-shape aggregates without the field", () => {
    const old = renderReport(makeAgg({ promptBreakdown: undefined }), makeConfig());
    expect(old).toContain("No prompts had enough completed samples to break down");
    expectClean(old);
  });
});

describe("renderReport — R4 trend polish", () => {
  const html = renderReport(makeAgg(), makeConfig());

  it("draws an accent area fill and y-axis gridline labels", () => {
    expect(html).toContain('class="trend-area"');
    expect(html).toContain('class="trend-grid"');
    expect(html).toContain('class="trend-axis"');
    // top gridline label for maxRate 0.5 * 1.25 = 0.625 → 63%
    expect(html).toContain(">63%</text>");
    expect(html).toContain(">0%</text>");
  });

  it("labels every point and keeps the >=2-point gate", () => {
    expect(html).toContain(">31%</text>");
    expect(html).toContain(">50%</text>");
    const single = renderReport(
      makeAgg({ trend: [{ date: "2026-06-30", promptSetVersion: "v1.3.0", overallMentionRate: 0.4 }] }),
      makeConfig(),
    );
    expect(single).not.toContain("<svg");
    expectClean(single);
  });
});

describe("renderReport — escaping", () => {
  const hostile = "<script>alert(1)</script>";
  const html = renderReport(
    makeAgg({
      client: makeBrand({ name: hostile }),
      competitors: [
        { name: hostile, mentions: 3, isClient: false },
        { name: "TIkit", mentions: 1, isClient: true },
      ],
      citationGaps: [
        {
          domain: '"><img src=x onerror=alert(1)>',
          exampleTitle: hostile,
          competitorsCited: [hostile],
          clientCited: false,
        },
      ],
      sources: {
        completedRuns: 10,
        rows: [{ domain: '"><img src=x onerror=alert(1)>', runsCiting: 4, clientCited: false }],
      },
      pullQuote: { text: hostile, provider: "openai", brand: hostile, isClient: false },
      promptBreakdown: [
        { promptText: hostile, cells: [{ provider: "openai", samples: 5, mentioned: 0 }] },
      ],
    }),
    makeConfig({ client: makeBrand({ name: hostile }) }),
  );

  it("never emits the raw payload anywhere in the document", () => {
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expectClean(html);
  });

  it("htmlEscape covers all five special characters", () => {
    expect(htmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("renderReport — white-label header", () => {
  it("renders the agency name as text when no logoUrl is given", () => {
    const html = renderReport(makeAgg(), makeConfig());
    expect(html).toContain("Northwind Digital");
    expect(html).not.toContain("<img");
  });

  it("renders an <img> when logoUrl is present", () => {
    const html = renderReport(
      makeAgg(),
      makeConfig({
        whiteLabel: {
          agencyName: "Northwind Digital",
          logoUrl: "data:image/png;base64,iVBORw0KGgo=",
          accentColor: "#b4552d",
        },
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('alt="Northwind Digital"');
    expectClean(html);
  });

  it("uses the accent color in the stylesheet", () => {
    const html = renderReport(makeAgg(), makeConfig());
    expect(html).toContain("--accent: #b4552d");
  });

  it("passes a 3-digit hex accent through unchanged", () => {
    const html = renderReport(
      makeAgg(),
      makeConfig({ whiteLabel: { agencyName: "Northwind Digital", accentColor: "#abc" } }),
    );
    expect(html).toContain("--accent: #abc;");
  });

  it("neutralizes a CSS-injection accentColor, falling back to the safe default", () => {
    const payload = "red;} body{display:none} :root{--x:";
    const html = renderReport(
      makeAgg(),
      makeConfig({ whiteLabel: { agencyName: "Northwind Digital", accentColor: payload } }),
    );
    // The raw payload must NOT reach the CSS context, in any escaped form.
    expect(html).not.toContain(payload);
    expect(html).not.toContain("body{display:none}");
    expect(html).not.toContain("display:none");
    // The safe default accent is used instead.
    expect(html).toContain("--accent: #1a56db;");
    expectClean(html);
  });
});
