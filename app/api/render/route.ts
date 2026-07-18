/**
 * POST /api/render body: { configName, acknowledgeOutage? }
 *   → { reportFile } | 409 { error: "outage", outageProviders }
 * Renders results.jsonl → report HTML (lib/ui/renderPipeline), writing
 * reportPath(name, today) and trendPath(name). Refuses on outage unless
 * acknowledged.
 */
import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadConfig } from "../../../lib/ui/configStore";
import { isOutage, providerCompletion, renderFromResults } from "../../../lib/ui/renderPipeline";
import { reportPath, resultsPath, trendPath } from "../../lib/contract";
import type { OutageResponse, RenderRequest, RenderResponse } from "../../lib/contract";
import type { TrendPoint } from "../../../lib/types";
import { loadCells } from "../_lib/cells";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as RenderRequest;
  if (!body?.configName) {
    return NextResponse.json({ error: "configName required" }, { status: 400 });
  }

  let config;
  try {
    config = loadConfig(body.configName);
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const cells = loadCells(resultsPath(body.configName));
  if (cells.length === 0) {
    return NextResponse.json({ error: "no-results" }, { status: 400 });
  }

  const tPath = trendPath(body.configName);
  const priorTrend: TrendPoint[] = existsSync(tPath)
    ? (JSON.parse(readFileSync(tPath, "utf8")) as TrendPoint[])
    : [];

  const result = renderFromResults({
    config,
    cells,
    priorTrend,
    acknowledgeOutage: body.acknowledgeOutage,
  });

  if (isOutage(result)) {
    const res: OutageResponse = {
      error: "outage",
      outageProviders: result.outageProviders,
      completion: providerCompletion(cells, config),
    };
    return NextResponse.json(res, { status: 409 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const outPath = reportPath(body.configName, today);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.html);

  mkdirSync(dirname(tPath), { recursive: true });
  writeFileSync(tPath, JSON.stringify(result.trend, null, 2));

  const res: RenderResponse = { reportFile: basename(outPath) };
  return NextResponse.json(res);
}
