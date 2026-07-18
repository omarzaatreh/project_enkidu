/**
 * GET /api/reports → Array<{ file, mtime }>
 * Lists rendered reports in reports/, newest first (mtime is ISO 8601).
 */
import { NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReportListEntry } from "../../lib/contract";

export const dynamic = "force-dynamic";

const REPORTS_DIR = "reports";

export function GET(): NextResponse {
  if (!existsSync(REPORTS_DIR)) return NextResponse.json([]);
  const entries: ReportListEntry[] = readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ file: f, mtime: statSync(join(REPORTS_DIR, f)).mtime.toISOString() }))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return NextResponse.json(entries);
}
