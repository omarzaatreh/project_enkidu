/**
 * Anthropic Messages API adapter (web_search server tool).
 *
 * parseAnthropicResponse is pure so fixtures can drive tests with no network.
 */

import type { Adapter, AdapterResponse, Citation } from "../types.js";
import { urlToDomain } from "../shared/normalize.js";
import { callWithRetry, HttpError } from "../shared/callWithRetry.js";

const ANTHROPIC_VERSION = "2023-06-01";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Text = concatenation of content blocks with type "text". Citations come
 * primarily from those text blocks' `citations` arrays (entries of type
 * "web_search_result_location"); when none are present, falls back to
 * `web_search_tool_result` blocks' content entries of type
 * "web_search_result". Deduped by url. Missing/malformed metadata →
 * citations: []. Empty/missing text → throws (the cell fails).
 */
export function parseAnthropicResponse(json: unknown): AdapterResponse {
  const content =
    isRecord(json) && Array.isArray(json["content"]) ? json["content"] : [];

  const textParts: string[] = [];
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  const addCitation = (entry: Record<string, unknown>): void => {
    const url = entry["url"];
    if (typeof url !== "string" || url.length === 0) return;
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    const title = entry["title"];
    citations.push({
      url,
      domain: urlToDomain(url),
      ...(typeof title === "string" ? { title } : {}),
    });
  };

  // Primary source: text blocks and their inline citation locations.
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    if (typeof block["text"] === "string") textParts.push(block["text"]);

    const blockCitations = block["citations"];
    if (!Array.isArray(blockCitations)) continue;
    for (const c of blockCitations) {
      if (!isRecord(c) || c["type"] !== "web_search_result_location") continue;
      addCitation(c);
    }
  }

  // Fallback: raw web_search_tool_result blocks.
  if (citations.length === 0) {
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "web_search_tool_result") {
        continue;
      }
      const results = block["content"];
      if (!Array.isArray(results)) continue;
      for (const r of results) {
        if (!isRecord(r) || r["type"] !== "web_search_result") continue;
        addCitation(r);
      }
    }
  }

  const responseText = textParts.join("");
  if (responseText.trim().length === 0) {
    throw new Error("Anthropic response contained no text content");
  }
  return { responseText, citations };
}

export function makeAnthropicAdapter(apiKey: string): Adapter {
  return async (req) => {
    const json = await callWithRetry(async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: 1024,
          messages: [{ role: "user", content: req.promptText }],
          tools: [
            { type: "web_search_20250305", name: "web_search", max_uses: 3 },
          ],
        }),
      });
      if (!res.ok) {
        throw new HttpError(res.status, `Anthropic HTTP ${res.status}`);
      }
      return (await res.json()) as unknown;
    });
    return parseAnthropicResponse(json);
  };
}
