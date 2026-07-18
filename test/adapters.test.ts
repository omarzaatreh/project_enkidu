/**
 * Adapter parsing tests — FIXTURE-AGNOSTIC by design.
 *
 * fixtures/*.response.json start life synthetic and are REPLACED by real
 * captured responses via `npm run capture-fixtures`. Expectations are
 * therefore derived structurally from whatever fixture is on disk — never
 * hardcoded from fixture content — so the suite validates the parser against
 * real provider shapes the moment they're captured.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOpenAIResponse } from "../backend/core/adapters/openai.js";
import { parseAnthropicResponse } from "../backend/core/adapters/anthropic.js";
import { parsePerplexityResponse } from "../backend/core/adapters/perplexity.js";
import { urlToDomain } from "../backend/core/shared/normalize.js";

function loadFixture(name: string): Record<string, unknown> {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

describe("urlToDomain (anchors the domain expectations below)", () => {
  it("lowercases and strips www.", () => {
    expect(urlToDomain("https://WWW.Byrdie.com/best-creator-agencies")).toBe("byrdie.com");
    expect(urlToDomain("https://influencermarketinghub.com/x?y=1")).toBe("influencermarketinghub.com");
  });
});

// ---------------------------------------------------------------- OpenAI

describe("parseOpenAIResponse", () => {
  const fixture = () => loadFixture("openai.response.json");

  /** Structural derivation mirroring the documented Responses API shape. */
  function derive(json: Record<string, unknown>) {
    const output = (json["output"] as Array<Record<string, unknown>>) ?? [];
    const contents = output
      .filter((o) => o["type"] === "message")
      .flatMap((o) => (o["content"] as Array<Record<string, unknown>>) ?? [])
      .filter((c) => c["type"] === "output_text");
    const text = contents.map((c) => c["text"] as string).join("");
    const urls = dedupe(
      contents
        .flatMap((c) => (c["annotations"] as Array<Record<string, unknown>>) ?? [])
        .filter((a) => a["type"] === "url_citation")
        .map((a) => a["url"] as string),
    );
    return { text, urls };
  }

  it("extracts the full text and all url_citation annotations from the fixture", () => {
    const expected = derive(fixture());
    expect(expected.text.length).toBeGreaterThan(0); // fixture sanity
    const parsed = parseOpenAIResponse(fixture());
    expect(parsed.responseText).toBe(expected.text);
    expect(parsed.citations.map((c) => c.url)).toEqual(expected.urls);
    expect(parsed.citations.map((c) => c.domain)).toEqual(expected.urls.map(urlToDomain));
  });

  it("dedupes citations by url", () => {
    const json = fixture();
    const output = (json["output"] as Array<Record<string, unknown>>) ?? [];
    const firstContent = output
      .filter((o) => o["type"] === "message")
      .flatMap((o) => (o["content"] as Array<Record<string, unknown>>) ?? [])
      .find((c) => c["type"] === "output_text");
    const annotations = (firstContent?.["annotations"] as Array<unknown>) ?? [];
    if (annotations.length > 0) annotations.push(structuredClone(annotations[0]));
    const parsed = parseOpenAIResponse(json);
    expect(parsed.citations.map((c) => c.url)).toEqual(dedupe(parsed.citations.map((c) => c.url)));
  });

  it("keeps text and returns empty citations when annotations are stripped", () => {
    const json = structuredClone(fixture());
    const output = (json["output"] as Array<Record<string, unknown>>) ?? [];
    for (const o of output) {
      if (o["type"] !== "message") continue;
      for (const c of (o["content"] as Array<Record<string, unknown>>) ?? []) delete c["annotations"];
    }
    const parsed = parseOpenAIResponse(json);
    expect(parsed.responseText).toBe(derive(fixture()).text);
    expect(parsed.citations).toEqual([]);
  });

  it("tolerates malformed (non-array) annotations", () => {
    const json = structuredClone(fixture());
    const output = (json["output"] as Array<Record<string, unknown>>) ?? [];
    for (const o of output) {
      if (o["type"] !== "message") continue;
      for (const c of (o["content"] as Array<Record<string, unknown>>) ?? []) c["annotations"] = "garbage";
    }
    const parsed = parseOpenAIResponse(json);
    expect(parsed.responseText).toBe(derive(fixture()).text);
    expect(parsed.citations).toEqual([]);
  });

  it("throws on an empty response body", () => {
    expect(() => parseOpenAIResponse({})).toThrow();
    expect(() => parseOpenAIResponse({ output: [] })).toThrow();
  });
});

// -------------------------------------------------------------- Anthropic

describe("parseAnthropicResponse", () => {
  const fixture = () => loadFixture("anthropic.response.json");

  /** Structural derivation mirroring the documented Messages API shape.
   * Real captures may include thinking blocks, multiple server_tool_use
   * blocks, and many interleaved text blocks — derive over all of them. */
  function derive(json: Record<string, unknown>) {
    const content = (json["content"] as Array<Record<string, unknown>>) ?? [];
    const textBlocks = content.filter((b) => b["type"] === "text");
    const text = textBlocks.map((b) => b["text"] as string).join("");
    const inlineUrls = dedupe(
      textBlocks
        .flatMap((b) => (b["citations"] as Array<Record<string, unknown>>) ?? [])
        .filter((c) => c["type"] === "web_search_result_location")
        .map((c) => c["url"] as string),
    );
    const toolResultUrls = dedupe(
      content
        .filter((b) => b["type"] === "web_search_tool_result")
        .flatMap((b) => (b["content"] as Array<Record<string, unknown>>) ?? [])
        .filter((r) => r["type"] === "web_search_result")
        .map((r) => r["url"] as string),
    );
    return { text, inlineUrls, toolResultUrls };
  }

  it("extracts the full text and inline web_search_result_location citations", () => {
    const expected = derive(fixture());
    expect(expected.text.length).toBeGreaterThan(0); // fixture sanity
    expect(expected.inlineUrls.length).toBeGreaterThan(0); // grounded responses cite
    const parsed = parseAnthropicResponse(fixture());
    expect(parsed.responseText).toBe(expected.text);
    expect(parsed.citations.map((c) => c.url)).toEqual(expected.inlineUrls);
    expect(parsed.citations.map((c) => c.domain)).toEqual(expected.inlineUrls.map(urlToDomain));
  });

  it("falls back to web_search_tool_result blocks when text blocks carry no citations", () => {
    const json = structuredClone(fixture());
    const content = json["content"] as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block["type"] === "text") delete block["citations"];
    }
    const expected = derive(fixture());
    const parsed = parseAnthropicResponse(json);
    expect(parsed.responseText).toBe(expected.text);
    expect(parsed.citations.map((c) => c.url)).toEqual(expected.toolResultUrls);
  });

  it("keeps text and returns empty citations when all citation metadata is stripped", () => {
    const json = structuredClone(fixture());
    const content = json["content"] as Array<Record<string, unknown>>;
    const withoutToolResults = content.filter((block) => block["type"] !== "web_search_tool_result");
    for (const block of withoutToolResults) {
      if (block["type"] === "text") delete block["citations"];
    }
    json["content"] = withoutToolResults;
    const parsed = parseAnthropicResponse(json);
    expect(parsed.responseText).toBe(derive(fixture()).text);
    expect(parsed.citations).toEqual([]);
  });

  it("throws on an empty response body", () => {
    expect(() => parseAnthropicResponse({})).toThrow();
    expect(() => parseAnthropicResponse({ content: [] })).toThrow();
  });
});

// ------------------------------------------------------------- Perplexity

describe("parsePerplexityResponse", () => {
  const fixture = () => loadFixture("perplexity.response.json");

  function derive(json: Record<string, unknown>) {
    const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
    const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
    const text = (message?.["content"] as string) ?? "";
    const searchResults = (json["search_results"] as Array<Record<string, unknown>>) ?? [];
    const searchUrls = dedupe(searchResults.map((r) => r["url"] as string));
    const bareCitations = dedupe(((json["citations"] as string[]) ?? []).filter((u) => typeof u === "string"));
    return { text, searchUrls, bareCitations };
  }

  it("extracts text and titled citations from search_results", () => {
    const expected = derive(fixture());
    expect(expected.text.length).toBeGreaterThan(0); // fixture sanity
    const parsed = parsePerplexityResponse(fixture());
    expect(parsed.responseText).toBe(expected.text);
    const expectedUrls = expected.searchUrls.length > 0 ? expected.searchUrls : expected.bareCitations;
    expect(parsed.citations.map((c) => c.url)).toEqual(expectedUrls);
    expect(parsed.citations.map((c) => c.domain)).toEqual(expectedUrls.map(urlToDomain));
  });

  it("falls back to the citations string array when search_results is absent", () => {
    const json = structuredClone(fixture());
    delete json["search_results"];
    const expected = derive(fixture());
    const parsed = parsePerplexityResponse(json);
    expect(parsed.responseText).toBe(expected.text);
    // Only meaningful when the fixture carries a bare citations array at all.
    expect(parsed.citations.map((c) => c.url)).toEqual(expected.bareCitations);
  });

  it("keeps text and returns empty citations when all citation metadata is stripped", () => {
    const json = structuredClone(fixture());
    delete json["search_results"];
    delete json["citations"];
    const parsed = parsePerplexityResponse(json);
    expect(parsed.responseText).toBe(derive(fixture()).text);
    expect(parsed.citations).toEqual([]);
  });

  it("throws on an empty response body", () => {
    expect(() => parsePerplexityResponse({})).toThrow();
    expect(() => parsePerplexityResponse({ choices: [] })).toThrow();
  });
});
