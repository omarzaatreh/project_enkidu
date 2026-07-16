import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOpenAIResponse } from "../lib/adapters/openai.js";
import { parseAnthropicResponse } from "../lib/adapters/anthropic.js";
import { parsePerplexityResponse } from "../lib/adapters/perplexity.js";

function loadFixture(name: string): Record<string, unknown> {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

describe("parseOpenAIResponse", () => {
  const fixture = () => loadFixture("openai.response.json");

  it("extracts response text and url_citation annotations from the fixture", () => {
    const parsed = parseOpenAIResponse(fixture());
    expect(parsed.responseText).toMatch(
      /^If you're looking for influencer marketing agencies/,
    );
    expect(parsed.citations.map((c) => c.url)).toEqual([
      "https://influencermarketinghub.com/influencer-marketing-agencies/",
      "https://www.byrdie.com/best-creator-agencies",
    ]);
    expect(parsed.citations.map((c) => c.domain)).toEqual([
      "influencermarketinghub.com",
      "byrdie.com",
    ]);
    expect(parsed.citations[0]?.title).toBe(
      "Top Influencer Marketing Agencies (2026)",
    );
  });

  it("dedupes citations by url", () => {
    const json = fixture();
    const output = json["output"] as Array<Record<string, unknown>>;
    const message = output[1] as Record<string, unknown>;
    const content = message["content"] as Array<Record<string, unknown>>;
    const entry = content[0] as Record<string, unknown>;
    const annotations = entry["annotations"] as Array<unknown>;
    annotations.push(structuredClone(annotations[0]));
    const parsed = parseOpenAIResponse(json);
    expect(parsed.citations).toHaveLength(2);
  });

  it("keeps text and returns empty citations when annotations are stripped", () => {
    const json = structuredClone(fixture());
    const output = json["output"] as Array<Record<string, unknown>>;
    const message = output[1] as Record<string, unknown>;
    const content = message["content"] as Array<Record<string, unknown>>;
    delete (content[0] as Record<string, unknown>)["annotations"];
    const parsed = parseOpenAIResponse(json);
    expect(parsed.responseText).toMatch(/^If you're looking/);
    expect(parsed.citations).toEqual([]);
  });

  it("tolerates malformed (non-array) annotations", () => {
    const json = structuredClone(fixture());
    const output = json["output"] as Array<Record<string, unknown>>;
    const message = output[1] as Record<string, unknown>;
    const content = message["content"] as Array<Record<string, unknown>>;
    (content[0] as Record<string, unknown>)["annotations"] = "garbage";
    const parsed = parseOpenAIResponse(json);
    expect(parsed.responseText).toMatch(/^If you're looking/);
    expect(parsed.citations).toEqual([]);
  });

  it("throws on an empty response body", () => {
    expect(() => parseOpenAIResponse({})).toThrow();
    expect(() => parseOpenAIResponse({ output: [] })).toThrow();
  });
});

describe("parseAnthropicResponse", () => {
  const fixture = () => loadFixture("anthropic.response.json");

  it("extracts text and inline web_search_result_location citations", () => {
    const parsed = parseAnthropicResponse(fixture());
    expect(parsed.responseText).toMatch(
      /^Based on recent rankings, The Goat Agency and Obviously/,
    );
    // Primary path: the text block's own citations array wins.
    expect(parsed.citations).toEqual([
      {
        url: "https://influencermarketinghub.com/influencer-marketing-agencies/",
        domain: "influencermarketinghub.com",
        title: "Top Influencer Marketing Agencies (2026)",
      },
    ]);
  });

  it("falls back to web_search_tool_result blocks when text blocks carry no citations", () => {
    const json = structuredClone(fixture());
    const content = json["content"] as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block["type"] === "text") delete block["citations"];
    }
    const parsed = parseAnthropicResponse(json);
    expect(parsed.responseText).toMatch(/^Based on recent rankings/);
    expect(parsed.citations.map((c) => c.url)).toEqual([
      "https://influencermarketinghub.com/influencer-marketing-agencies/",
      "https://www.adweek.com/creator-economy/agency-rankings",
    ]);
    expect(parsed.citations.map((c) => c.domain)).toEqual([
      "influencermarketinghub.com",
      "adweek.com",
    ]);
  });

  it("keeps text and returns empty citations when all citation metadata is stripped", () => {
    const json = structuredClone(fixture());
    const content = json["content"] as Array<Record<string, unknown>>;
    const withoutToolResults = content.filter(
      (block) => block["type"] !== "web_search_tool_result",
    );
    for (const block of withoutToolResults) {
      if (block["type"] === "text") delete block["citations"];
    }
    json["content"] = withoutToolResults;
    const parsed = parseAnthropicResponse(json);
    expect(parsed.responseText).toMatch(/^Based on recent rankings/);
    expect(parsed.citations).toEqual([]);
  });

  it("throws on an empty response body", () => {
    expect(() => parseAnthropicResponse({})).toThrow();
    expect(() => parseAnthropicResponse({ content: [] })).toThrow();
  });
});

describe("parsePerplexityResponse", () => {
  const fixture = () => loadFixture("perplexity.response.json");

  it("extracts text and titled citations from search_results", () => {
    const parsed = parsePerplexityResponse(fixture());
    expect(parsed.responseText).toMatch(
      /^For influencer marketing in 2026, top recommendations include The Goat Agency/,
    );
    expect(parsed.citations).toEqual([
      {
        url: "https://influencermarketinghub.com/influencer-marketing-agencies/",
        domain: "influencermarketinghub.com",
        title: "Top Influencer Marketing Agencies (2026)",
      },
      {
        url: "https://www.byrdie.com/best-creator-agencies",
        domain: "byrdie.com",
        title: "Best Creator Agencies",
      },
      {
        url: "https://www.reddit.com/r/marketing/comments/best_influencer_agencies",
        domain: "reddit.com",
        title: "best influencer agencies?",
      },
    ]);
  });

  it("falls back to the citations string array when search_results is absent", () => {
    const json = structuredClone(fixture());
    delete json["search_results"];
    const parsed = parsePerplexityResponse(json);
    expect(parsed.citations.map((c) => c.url)).toEqual([
      "https://influencermarketinghub.com/influencer-marketing-agencies/",
      "https://www.byrdie.com/best-creator-agencies",
      "https://www.reddit.com/r/marketing/comments/best_influencer_agencies",
    ]);
    expect(parsed.citations.every((c) => c.title === undefined)).toBe(true);
  });

  it("keeps text and returns empty citations when all citation metadata is stripped", () => {
    const json = structuredClone(fixture());
    delete json["search_results"];
    delete json["citations"];
    const parsed = parsePerplexityResponse(json);
    expect(parsed.responseText).toMatch(/^For influencer marketing in 2026/);
    expect(parsed.citations).toEqual([]);
  });

  it("throws on an empty response body", () => {
    expect(() => parsePerplexityResponse({})).toThrow();
    expect(() =>
      parsePerplexityResponse({ choices: [{ message: { content: "" } }] }),
    ).toThrow();
  });
});
