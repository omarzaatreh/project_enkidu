/**
 * GET /api/runs/failures?config=name → FailuresResponse
 *
 * The latest-wins FAILED generation cells for the CURRENT plan, so the Run
 * page's terminal state can list each failure's provider, prompt, and stored
 * error TEXT instead of a bare "2 failed".
 *
 * Uses the SAME run/plan + cell-loading as GET /api/runs/progress: it loads the
 * per-config results.jsonl (resultsPath) and reconstructs the planned generation
 * cells with the runner's content-hash IDs (deriveFailures). "Latest wins" per
 * cellId means a cell that failed and was later retried successfully is
 * represented by its ok retry and is NOT listed — so a transient failure that
 * recovered never shows up as a failure.
 *
 * Read-only: touches only config/ and results/. Never returns API keys or a path
 * outside results/.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "../../../../backend/services/configStore";
import { loadCells } from "../../../../backend/services/cells";
import { deriveFailures } from "../../../../backend/services/progress";
import { resultsPath } from "../../../lib/contract";
import type { FailuresResponse, RunConfig, RunFailure } from "../../../lib/contract";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest): NextResponse {
  const name = req.nextUrl.searchParams.get("config");
  if (!name) {
    return NextResponse.json({ error: "config query param required" }, { status: 400 });
  }

  let config: RunConfig;
  try {
    config = loadConfig(name);
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const failures = deriveFailures(loadCells(resultsPath(name)), config) as RunFailure[];
  const body: FailuresResponse = { failures };
  return NextResponse.json(body);
}
