/**
 * Text normalization + word-boundary alias matching (eng review issue 4A).
 *
 * Rules (design doc, extraction spec):
 * - normalize = lowercase + strip punctuation (keep [a-z0-9] and spaces,
 *   dots inside domains survive via token-level matching below)
 * - match on WORD BOUNDARIES, never bare substrings ("tikit" must not match
 *   inside an unrelated longer word)
 * - matching runs on response PROSE only; callers must never feed citation
 *   metadata through this — citations feed the gap table, not the mention rate.
 */

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9.\s]/g, " ") // punctuation → space (keep dots for domains)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAlias(s: string): string {
  return normalizeText(s);
}

/**
 * True iff `alias` appears in `text` on word boundaries after normalization.
 * Domains ("tikit.com") match as literal tokens including the dot.
 */
export function proseContainsAlias(text: string, alias: string): boolean {
  const t = ` ${normalizeText(text)} `;
  const a = normalizeAlias(alias);
  if (a.length === 0) return false;
  // Word boundary = surrounded by space or string edge in the padded text.
  // Dots are word characters here so "tikit.com" ≠ "tikit common".
  let idx = t.indexOf(a);
  while (idx !== -1) {
    const before = t[idx - 1];
    const after = t[idx + a.length];
    const beforeOk = before === " " || before === undefined;
    const afterOk = after === " " || after === "." || after === undefined;
    // Trailing dot allowed (end of sentence: "tikit."), but "tikit.com"
    // must not match alias "tikit" — check the char after the dot.
    if (beforeOk && afterOk) {
      if (after === ".") {
        const afterDot = t[idx + a.length + 1];
        if (afterDot === " " || afterDot === undefined) return true;
      } else {
        return true;
      }
    }
    idx = t.indexOf(a, idx + 1);
  }
  return false;
}

/** Extract the registrable domain from a URL, lowercased. Best-effort. */
export function urlToDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url.toLowerCase();
  }
}
