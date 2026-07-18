/**
 * POST /api/runs  body: { configName } → { started: true } | 409 run-in-progress
 * Acquires the run lock and starts the in-process driver (lib/ui/runManager).
 */
import { NextRequest, NextResponse } from "next/server";
import { RunInProgressError, startRun } from "../../../lib/ui/runManager";
import type { StartRunRequest, StartRunResponse } from "../../lib/contract";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as StartRunRequest;
  if (!body?.configName) {
    return NextResponse.json({ error: "configName required" }, { status: 400 });
  }
  try {
    startRun(body.configName);
    const res: StartRunResponse = { started: true };
    return NextResponse.json(res);
  } catch (err) {
    if (err instanceof RunInProgressError) {
      return NextResponse.json({ error: "run-in-progress" }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "run-failed" },
      { status: 500 },
    );
  }
}
