/**
 * Perplexity chat completions adapter (sonar models ground by default).
 *
 * parsePerplexityResponse is pure so fixtures can drive tests with no network.
 */

import type { Adapter, AdapterResponse, Citation } from "../types.js";
import { urlToDomain } from "../shared/normalize.js";
import { callWithRetry, HttpError } from "../shared/callWithRetry.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Text = choices[0].message.content. Citations come primarily from
 * `search_results` (which carries titles), falling back to the bare
 * `citations` string array. Deduped by url. Missing/malformed metadata →
 * citations: []. Empty/missing text → throws (the cell fails).
 */
export function parsePerplexityResponse(json: unknown): AdapterResponse {
  const root = isRecord(json) ? json : {};
  const choices = Array.isArray(root["choices"]) ? root["choices"] : [];
  const firstChoice: unknown = choices[0];
  const message =
    isRecord(firstChoice) && isRecord(firstChoice["message"])
      ? firstChoice["message"]
      : undefined;
  const responseText =
    message && typeof message["content"] === "string"
      ? message["content"]
      : "";

  if (responseText.trim().length === 0) {
    throw new Error("Perplexity response contained no message content");
  }

  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  // Primary source: search_results objects (they carry titles).
  const searchResults = root["search_results"];
  if (Array.isArray(searchResults)) {
    for (const r of searchResults) {
      if (!isRecord(r)) continue;
      const url = r["url"];
      if (typeof url !== "string" || url.length === 0) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const title = r["title"];
      citations.push({
        url,
        domain: urlToDomain(url),
        ...(typeof title === "string" ? { title } : {}),
      });
    }
  }

  // Fallback: bare `citations` string array (urls only, no titles).
  if (citations.length === 0) {
    const rawCitations = root["citations"];
    if (Array.isArray(rawCitations)) {
      for (const url of rawCitations) {
        if (typeof url !== "string" || url.length === 0) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        citations.push({ url, domain: urlToDomain(url) });
      }
    }
  }

  return { responseText, citations };
}

export function makePerplexityAdapter(apiKey: string): Adapter {
  return async (req) => {
    const json = await callWithRetry(async () => {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          messages: [{ role: "user", content: req.promptText }],
        }),
      });
      if (!res.ok) {
        throw new HttpError(res.status, `Perplexity HTTP ${res.status}`);
      }
      return (await res.json()) as unknown;
    });
    return parsePerplexityResponse(json);
  };
}
