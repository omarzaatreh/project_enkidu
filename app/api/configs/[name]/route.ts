/**
 * GET  /api/configs/[name] → RunConfig (verbatim)
 * PUT  /api/configs/[name]  body: RunConfig → { ok, promptSetVersion }
 * The PUT auto-bumps promptSet.version — the caller must NOT set it. Logic in
 * backend/services/configStore.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadConfig, saveConfig } from "../../../../backend/services/configStore";
import type { PutConfigResponse, RunConfig } from "../../../lib/contract";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { name } = await params;
  try {
    return NextResponse.json(loadConfig(name));
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
}

export async function PUT(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { name } = await params;
  const body = (await req.json()) as RunConfig;
  const { promptSetVersion } = saveConfig(name, body);
  const res: PutConfigResponse = { ok: true, promptSetVersion };
  return NextResponse.json(res);
}
