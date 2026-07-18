/**
 * GET /api/configs → ConfigSummary[]
 * Thin wrapper: lists config/*.json as summaries (logic in backend/services/configStore).
 */
import { NextResponse } from "next/server";
import { listConfigs } from "../../../backend/services/configStore";
import type { ConfigSummary } from "../../lib/contract";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const summaries: ConfigSummary[] = listConfigs();
  return NextResponse.json(summaries);
}
