/**
 * GET /api/estimate?config=name → EstimateResponse
 * Resume-aware scope (backend/services/estimate) × per-call price constants (app/lib/
 * pricing). estUsd covers the new generation calls plus one cheap extraction
 * call per new ok cell (assumes new calls succeed) — a rough pre-run number.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "../../../backend/services/configStore";
import { estimateCalls } from "../../../backend/services/estimate";
import { resultsPath } from "../../lib/contract";
import { EXTRACTION_PER_CALL_USD, PER_CALL_USD } from "../../lib/pricing";
import type { EstimateResponse } from "../../lib/contract";
import { loadCells } from "../../../backend/services/cells";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest): NextResponse {
  const name = req.nextUrl.searchParams.get("config");
  if (!name) return NextResponse.json({ error: "config query param required" }, { status: 400 });

  let config;
  try {
    config = loadConfig(name);
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const cells = loadCells(resultsPath(name));
  const { totalCalls, newCalls, newByProvider } = estimateCalls(config, cells);

  let estUsd = 0;
  for (const [provider, count] of Object.entries(newByProvider)) {
    const price = PER_CALL_USD[provider as keyof typeof PER_CALL_USD] ?? 0;
    estUsd += (count ?? 0) * price;
  }
  // One extraction call per new ok cell (rough: assumes new calls succeed).
  estUsd += newCalls * EXTRACTION_PER_CALL_USD;

  const res: EstimateResponse = {
    totalCalls,
    newCalls,
    estUsd: Math.round(estUsd * 100) / 100,
    note: "rough estimate; assumes new calls succeed and includes one extraction call per new cell; re-tune when model IDs are pinned",
  };
  return NextResponse.json(res);
}
