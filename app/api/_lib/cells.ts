/**
 * Tiny disk reader shared by the route handlers. Kept out of lib/ui because it
 * is app-only glue (the route wrappers own file loading); the heavy logic lives
 * in lib/ui and is unit-tested under the root harness.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Cell } from "../../../lib/types";

/** Read a per-config results.jsonl into Cell[] (missing file → []). */
export function loadCells(path: string): Cell[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Cell);
}
