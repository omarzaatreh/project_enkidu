/**
 * Captures ONE real grounded response per provider into fixtures/, replacing
 * the synthetic fixtures. Run once API keys exist in .env:
 *
 *   npm run capture-fixtures
 *
 * Costs a few cents. Re-run the test suite afterward — adapter parsing tests
 * assert against these files, so real shapes keep the suite honest.
 */
import { writeFileSync } from "node:fs";

const PROMPT = "What are the best influencer marketing agencies in 2026?";

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function captureOpenAI(key: string) {
  const json = await post(
    "https://api.openai.com/v1/responses",
    { authorization: `Bearer ${key}` },
    { model: "gpt-5", input: PROMPT, tools: [{ type: "web_search" }] },
  );
  writeFileSync("fixtures/openai.response.json", JSON.stringify(json, null, 2));
  console.log("✓ fixtures/openai.response.json (real)");
}

async function captureAnthropic(key: string) {
  const json = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: PROMPT }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    },
  );
  writeFileSync("fixtures/anthropic.response.json", JSON.stringify(json, null, 2));
  console.log("✓ fixtures/anthropic.response.json (real)");
}

async function capturePerplexity(key: string) {
  const json = await post(
    "https://api.perplexity.ai/chat/completions",
    { authorization: `Bearer ${key}` },
    { model: "sonar", messages: [{ role: "user", content: PROMPT }] },
  );
  writeFileSync("fixtures/perplexity.response.json", JSON.stringify(json, null, 2));
  console.log("✓ fixtures/perplexity.response.json (real)");
}

const tasks: Array<Promise<void>> = [];
const { OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY } = process.env;
if (OPENAI_API_KEY) tasks.push(captureOpenAI(OPENAI_API_KEY));
else console.warn("⨯ OPENAI_API_KEY missing — keeping synthetic fixture");
if (ANTHROPIC_API_KEY) tasks.push(captureAnthropic(ANTHROPIC_API_KEY));
else console.warn("⨯ ANTHROPIC_API_KEY missing — keeping synthetic fixture");
if (PERPLEXITY_API_KEY) tasks.push(capturePerplexity(PERPLEXITY_API_KEY));
else console.warn("⨯ PERPLEXITY_API_KEY missing — keeping synthetic fixture");

const results = await Promise.allSettled(tasks);
for (const r of results) if (r.status === "rejected") console.error(r.reason);
