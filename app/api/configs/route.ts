/**
 * GET /api/configs → ConfigSummary[]
 * Thin wrapper: lists config/*.json as summaries (logic in lib/ui/configStore).
 */
import { NextResponse } from "next/server";
import { listConfigs } from "../../../lib/ui/configStore";
import type { ConfigSummary } from "../../lib/contract";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const summaries: ConfigSummary[] = listConfigs();
  return NextResponse.json(summaries);
}
