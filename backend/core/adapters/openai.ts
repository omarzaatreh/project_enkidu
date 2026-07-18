/**
 * OpenAI Responses API adapter (web_search grounding).
 *
 * parseOpenAIResponse is pure so fixtures can drive tests with no network.
 */

import type { Adapter, AdapterResponse, Citation } from "../types.js";
import { urlToDomain } from "../shared/normalize.js";
import { callWithRetry, HttpError } from "../shared/callWithRetry.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Concatenates every output → message → content entry of type "output_text";
 * citations come from those entries' `annotations` of type "url_citation",
 * deduped by url. Missing/malformed annotations → citations: [].
 * Empty/missing text → throws (the cell fails).
 */
export function parseOpenAIResponse(json: unknown): AdapterResponse {
  const output =
    isRecord(json) && Array.isArray(json["output"]) ? json["output"] : [];

  const textParts: string[] = [];
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  for (const item of output) {
    if (!isRecord(item) || item["type"] !== "message") continue;
    const content = item["content"];
    if (!Array.isArray(content)) continue;

    for (const entry of content) {
      if (!isRecord(entry) || entry["type"] !== "output_text") continue;
      if (typeof entry["text"] === "string") textParts.push(entry["text"]);

      const annotations = entry["annotations"];
      if (!Array.isArray(annotations)) continue;
      for (const ann of annotations) {
        if (!isRecord(ann) || ann["type"] !== "url_citation") continue;
        const url = ann["url"];
        if (typeof url !== "string" || url.length === 0) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        const title = ann["title"];
        citations.push({
          url,
          domain: urlToDomain(url),
          ...(typeof title === "string" ? { title } : {}),
        });
      }
    }
  }

  const responseText = textParts.join("");
  if (responseText.trim().length === 0) {
    throw new Error("OpenAI response contained no output text");
  }
  return { responseText, citations };
}

export function makeOpenAIAdapter(apiKey: string): Adapter {
  return async (req) => {
    const json = await callWithRetry(async () => {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          input: req.promptText,
          tools: [{ type: "web_search" }],
        }),
      });
      if (!res.ok) {
        throw new HttpError(res.status, `OpenAI HTTP ${res.status}`);
      }
      return (await res.json()) as unknown;
    });
    return parseOpenAIResponse(json);
  };
}
