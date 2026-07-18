/**
 * GET /api/reports → Array<{ file, mtime }>
 * Lists rendered reports in reports/, newest first (mtime is ISO 8601).
 */
import { NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resultsPath } from "../../lib/contract";
import type { ReportListEntry } from "../../lib/contract";

export const dynamic = "force-dynamic";

const REPORTS_DIR = "reports";
/** Report files are `${configName}-YYYY-MM-DD.html`; group 1 is the config name. */
const NAME_DATE_RE = /^(.+)-\d{4}-\d{2}-\d{2}\.html$/;

/**
 * A report is stale when its config's results file exists and is newer than the
 * rendered report (data/config changed since the render). Filenames that don't
 * match the `<name>-<date>.html` pattern, or configs with no results file, are
 * never stale — and any fs error degrades to stale:false rather than throwing.
 */
function isStale(file: string, reportMtimeMs: number): boolean {
  const m = NAME_DATE_RE.exec(file);
  const name = m?.[1];
  if (!name) return false;
  try {
    const rp = resultsPath(name);
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
      return {
        file: f,
        mtime: reportMtime.toISOString(),
        stale: isStale(f, reportMtime.getTime()),
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return NextResponse.json(entries);
}
