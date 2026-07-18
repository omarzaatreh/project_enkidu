/**
 * GET /api/runs/active → ActiveRunResponse
 * Reports whether a live run holds the lock (backend/services/runManager).
 */
import { NextResponse } from "next/server";
import { activeRun } from "../../../../backend/services/runManager";
import type { ActiveRunResponse } from "../../../lib/contract";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const res: ActiveRunResponse = activeRun();
  return NextResponse.json(res);
}
