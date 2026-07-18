/**
 * GET /api/answers?config=name&promptId=id → AnswersResponse
 *
 * The ground-truth "why did detectMention say no?" endpoint for ONE prompt:
 * returns every OK generation cell for that prompt (prose, citations, model,
 * sample index, timestamp) joined to its latest extraction's discovered brands,
 * plus the client/competitor aliases so the panel can highlight mentions with
 * the SAME word-boundary semantics the server uses.
 *
 * Truthfulness contract (mirrors the R2 heatmap + report):
 *  - Answers are joined by promptText, NOT promptId: prompt ids regenerate on
 *    any text edit, so promptText is the hash-faithful identity. The URL takes
 *    the (nicer) promptId and resolves it to promptText against the CURRENT
 *    config server-side; an id absent from the config 404s.
 *  - The SAME orphan/enabled-provider filter as the heatmap runs first
 *    (filterToCurrentCells), so the cells shown here are exactly the cells the
 *    heatmap counted — no more, no less.
 *  - Extractions join latest-wins per generationCellId (dedupeExtractions), the
 *    identical rule the report/curation use, so stale extractions never double.
 *
 * Read-only: touches only config/ and results/. Never returns API keys or any
 * path outside results/. Payload is scoped to one prompt (~5–15 cells).
 */
import { NextRequest, NextResponse } from "next/server";
import { isValidConfigName, loadConfig } from "../../../backend/services/configStore";
import { loadCells } from "../../../backend/services/cells";
import { filterToCurrentCells } from "../../../backend/core/cellFilter";
import { dedupeExtractions } from "../../../backend/core/extract";
import { resultsPath } from "../../lib/contract";
import type { AnswersResponse, AnswerCell } from "../../lib/contract";
import type { GenerationCell, ExtractionCell } from "../../../backend/core/types";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest): NextResponse {
  const name = req.nextUrl.searchParams.get("config");
  const promptId = req.nextUrl.searchParams.get("promptId");
  if (!name || !promptId) {
    return NextResponse.json(
      { error: "config and promptId query params required" },
      { status: 400 },
    );
  }
  if (!isValidConfigName(name))
    return NextResponse.json({ error: "invalid config name" }, { status: 400 });

  let config;
  try {
    config = loadConfig(name);
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  // Resolve the (regenerate-on-edit) promptId to the hash-faithful promptText
  // against the CURRENT config. Unknown id → clean 404.
  const prompt = config.promptSet.prompts.find((p) => p.id === promptId);
  if (!prompt) {
    return NextResponse.json({ error: "prompt-not-found" }, { status: 404 });
  }
  const promptText = prompt.text;

  // SAME cell set as the heatmap: drop orphans / disabled providers first.
  const cells = filterToCurrentCells(loadCells(resultsPath(name)), config);

  // Latest-wins brands per generation cell (mirrors report/curation join).
  const brandsByGen = new Map<string, string[]>();
  for (const ext of dedupeExtractions(
    cells.filter((c): c is ExtractionCell => c.kind === "extraction"),
  )) {
    brandsByGen.set(ext.generationCellId, ext.brands ?? []);
  }

  const answers: AnswerCell[] = cells
    .filter(
      (c): c is GenerationCell =>
        c.kind === "generation" &&
        c.status === "ok" &&
        c.promptText === promptText &&
        typeof c.responseText === "string",
    )
    .map((c) => ({
      provider: c.provider,
      model: c.model,
      sampleIndex: c.sampleIndex,
      responseText: c.responseText ?? "",
      citations: c.citations ?? [],
      timestamp: c.timestamp,
      brands: brandsByGen.get(c.cellId) ?? [],
    }))
    .sort((a, b) =>
      a.provider === b.provider
        ? a.sampleIndex - b.sampleIndex
        : a.provider.localeCompare(b.provider),
    );

  const body: AnswersResponse = {
    promptId,
    promptText,
    // Aliases the panel highlights with — scoped from the config the cells were
    // filtered against, so client-side highlighting mirrors server semantics.
    clientAliases: [config.client.name, ...config.client.aliases, config.client.domain].filter(
      (a) => a.trim().length > 0,
    ),
    competitorAliases: config.competitors.flatMap((c) => [c.name, ...c.aliases]).filter(
      (a) => a.trim().length > 0,
    ),
    cells: answers,
  };
  return NextResponse.json(body);
}
