/**
 * GET /api/reports/[file] → the report HTML (text/html)
 * Serves one rendered report for preview. Path-traversal guard: any file param
 * containing "/", "\\", or ".." is rejected — reports are flat files in reports/.
 */
import { NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ file: string }> };

export async function GET(_req: NextRequest, { params }: Ctx): Promise<Response> {
  const { file } = await params;
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    return new Response("bad request", { status: 400 });
  }
  const path = join("reports", file);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  return new Response(readFileSync(path, "utf8"), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
