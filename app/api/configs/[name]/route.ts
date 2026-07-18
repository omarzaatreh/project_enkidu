/**
 * GET  /api/configs/[name] → RunConfig (verbatim)
 * PUT  /api/configs/[name]  body: RunConfig → { ok, promptSetVersion }
 * The PUT auto-bumps promptSet.version — the caller must NOT set it. Logic in
 * backend/services/configStore.
 */
import { NextRequest, NextResponse } from "next/server";
import { isValidConfigName, loadConfig, saveConfig } from "../../../../backend/services/configStore";
import { isValidAccentColor } from "../../../../backend/core/render";
import type { PutConfigResponse, RunConfig } from "../../../lib/contract";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { name } = await params;
  if (!isValidConfigName(name))
    return NextResponse.json({ error: "invalid config name" }, { status: 400 });
  try {
    return NextResponse.json(loadConfig(name));
  } catch {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
}

export async function PUT(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { name } = await params;
  if (!isValidConfigName(name))
    return NextResponse.json({ error: "invalid config name" }, { status: 400 });
  const body = (await req.json()) as RunConfig;
  // Belt-and-suspenders for the CSS-injection fix in render.ts: accentColor lands
  // in a CSS context in the paid report, so reject a non-hex value here (400) and
  // let the founder fix it rather than silently coercing on save.
  if (!isValidAccentColor(body?.whiteLabel?.accentColor)) {
    return NextResponse.json({ error: "invalid accentColor (expected hex, e.g. #1a56db)" }, { status: 400 });
  }
  const { promptSetVersion } = saveConfig(name, body);
  const res: PutConfigResponse = { ok: true, promptSetVersion };
  return NextResponse.json(res);
}
