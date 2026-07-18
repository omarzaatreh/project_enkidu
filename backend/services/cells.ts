/**
 * Tiny disk reader shared by the route handlers. Pure JSONL→Cell[] parsing with
 * no route/request coupling, so it lives with the other backend service logic
 * under backend/services and can be reused outside the Next routes.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Cell } from "../core/types.js";

/** Read a per-config results.jsonl into Cell[] (missing file → []). */
export function loadCells(path: string): Cell[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Cell);
}
