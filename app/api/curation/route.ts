/**
 * GET  /api/curation?config=name → { candidates }
 * POST /api/curation  body: { configName, promote } → { ok, competitors }
 * Curation tally + promote share lib/ui/curation with the CLI. Promote saves
 * the config (auto-bumping nothing — prompt texts are untouched).
 */
import { NextRequest, NextResponse } from "next/server";
import { loadConfig, saveConfig } from "../../../lib/ui/configStore";
import { curationCandidates, promoteCompetitors } from "../../../lib/ui/curation";
import { resultsPath } from "../../lib/contract";
import type {
  CurationPromoteResponse,
  CurationResponse,
  Curation_PromoteRequest,
} from "../../lib/contract";
import { loadCells } from "../_lib/cells";

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

  const currentPromptTexts = new Set(config.promptSet.prompts.map((p) => p.text));
  const candidates = curationCandidates(loadCells(resultsPath(name)), config, currentPromptTexts);
  const res: CurationResponse = { candidates };
  return NextResponse.json(res);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as Curation_PromoteRequest;
  if (!body?.configName || !Array.isArray(body.promote)) {
    return NextResponse.json({ error: "configName and promote[] required" }, { status: 400 });
  }

  let config;
  try {
    config = loadConfig(body.configName);
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const updated = promoteCompetitors(config, body.promote);
  saveConfig(body.configName, updated);
  const res: CurationPromoteResponse = { ok: true, competitors: updated.competitors.length };
  return NextResponse.json(res);
}
