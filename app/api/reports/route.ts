/**
 * GET /api/reports → Array<{ file, mtime }>
 * Lists rendered reports in reports/, newest first (mtime is ISO 8601).
 */
import { NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidConfigName } from "../../../backend/services/configStore";
import { parseReportName, resultsPath } from "../../lib/contract";
import type { ReportListEntry } from "../../lib/contract";

export const dynamic = "force-dynamic";

const REPORTS_DIR = "reports";

/**
 * A report is stale when its config's results file exists and is newer than the
 * rendered report (data/config changed since the render). Filenames that don't
 * match the `<name>-<date>.html` pattern, or configs with no results file, are
 * never stale — and any fs error degrades to stale:false rather than throwing.
 */
function isStale(configName: string | null, reportMtimeMs: number): boolean {
  if (!configName || !isValidConfigName(configName)) return false;
  try {
    const rp = resultsPath(configName);
    if (!existsSync(rp)) return false;
    return statSync(rp).mtime.getTime() > reportMtimeMs;
  } catch {
    return false;
  }
}

export function GET(): NextResponse {
  if (!existsSync(REPORTS_DIR)) return NextResponse.json([]);
  const entries: ReportListEntry[] = readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => {
      const reportMtime = statSync(join(REPORTS_DIR, f)).mtime;
      const { configName, reportDate } = parseReportName(f);
      return {
        file: f,
        mtime: reportMtime.toISOString(),
        stale: isStale(configName, reportMtime.getTime()),
        configName,
        reportDate,
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return NextResponse.json(entries);
}
