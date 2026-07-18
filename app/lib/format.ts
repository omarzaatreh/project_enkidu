/**
 * Pure formatting helpers shared across cockpit pages. Everything here guards
 * against NaN/undefined so a page never renders a broken number.
 */

/** Format a USD amount with exactly two decimals; non-finite → "$0.00". */
export function usd(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(2)}`;
}

/** Format an integer count; non-finite → "0". */
export function count(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return v.toLocaleString("en-US");
}

/** Percentage of done/total, clamped 0–100; guards division by zero. */
export function pct(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  const p = (done / total) * 100;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

/**
 * Slugify prompt text into a stable id, e.g.
 * "What are the best agencies?" → "what-are-the-best-agencies".
 */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "prompt";
}

/** Format an ISO timestamp for display; invalid → the raw string. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
