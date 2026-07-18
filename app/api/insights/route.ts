/**
 * GET /api/insights?config=name → InsightsResult
 * The prompt × provider mention matrix, citation-domain leaderboard, share of
 * voice, consistency flags, client co-occurrence, and per-category rollup for a
 * config, computed server-side from config/ + results/ (no keys, no paid work).
 * Shares backend/services/insights (and its cell filter) with the render
 * pipeline so insights and the report see one identical cell set.
 */
import { NextRequest, NextResponse } from "next/server";
import { isValidConfigName, loadConfig } from "../../../backend/services/configStore";
import { insightsFromResults } from "../../../backend/services/insights";
import { resultsPath } from "../../lib/contract";
import type { InsightsResult } from "../../lib/contract";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest): NextResponse {
  const name = req.nextUrl.searchParams.get("config");
  if (!name) return NextResponse.json({ error: "config query param required" }, { status: 400 });
  if (!isValidConfigName(name))
    return NextResponse.json({ error: "invalid config name" }, { status: 400 });

  let config;
  try {
    config = loadConfig(name);
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const insights: InsightsResult = insightsFromResults(config, resultsPath(name));
  return NextResponse.json(insights);
}
