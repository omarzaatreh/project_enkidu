"use client";

/**
 * /insights — the founder's first in-cockpit view of results. Fetches R1's
 * GET /api/insights?config= (InsightsResult) plus the RunConfig, and renders
 * four inline-SVG/CSS sections — NO chart library:
 *   1. Prompt × provider mention heatmap (rows grouped by category, "x/n" text
 *      ALWAYS printed inside each cell so color is never the only channel).
 *   2. Horizontal-bar citation-domain leaderboard (top 15).
 *   3. Share-of-voice stat row (one overall %, per-provider mini-bars).
 *   4. Co-occurrence table (with-you / instead-of-you per curated competitor).
 *
 * Truthfulness rules carried over from the R1 reviewer:
 *  - Every heatmap cell shows `samples` ("x/n"); insights includes ALL ok cells
 *    (no MIN_SAMPLES sufficiency rule), so a low-sample cell can disagree with
 *    the report — showing x/n keeps the founder honest.
 *  - byProvider arrays only carry providers PRESENT IN THE DATA; provider
 *    columns/bars fall back to Object.keys(config.models) so an enabled-but-empty
 *    provider still shows (as an empty column) instead of silently vanishing.
 *  - matrix/categories preserve results-file order — rows are REORDERED here by
 *    config.promptSet.prompts order for display.
 *  - domainLeaderboard counts citation OCCURRENCES — labeled "citations".
 */
import { Fragment, useState, type ReactNode } from "react";
import {
  API,
  type AnswersResponse,
  type InsightsResult,
  type MatrixCell,
  type Provider,
  type RunConfig,
  ROUTES,
} from "../lib/contract";
import { useJson, useSelectedConfig } from "../lib/client";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Loading, Section } from "../components/index";
import { count, pct } from "../lib/format";

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  perplexity: "Perplexity",
};
const providerLabel = (p: Provider): string => PROVIDER_LABELS[p] ?? p;

const COMPETITOR_RED = "#b42318";
const FLAKY_AMBER = "#f59e0b";

/**
 * Citation URLs originate from open-web AI search results, so their scheme is
 * untrusted. Only http(s) URLs are rendered as live anchors; anything else
 * (javascript:, data:, mailto:, unparseable, …) yields null and is shown as
 * plain text. React 19 already neutralizes javascript: hrefs — this is cheap
 * defense-in-depth, an explicit scheme allowlist. No dangerouslySetInnerHTML.
 */
function safeHttpUrl(u: string): string | null {
  try {
    const { protocol } = new URL(u);
    return protocol === "http:" || protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Background/foreground for a heatmap cell tinted by client mention fraction. */
function heatStyle(fraction: number): { backgroundColor: string; color: string } {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  // Pale accent at 0 (still readable dark text) → strong accent at 1 (white text).
  const alpha = 0.1 + 0.78 * f;
  return {
    backgroundColor: `rgba(26, 86, 219, ${alpha.toFixed(3)})`,
    color: f > 0.5 ? "#fff" : "var(--fg)",
  };
}

export default function InsightsPage() {
  const [selected] = useSelectedConfig();

  const insightsUrl = selected ? API.insightsPath(selected) : null;
  const configUrl = selected ? API.config(selected) : null;
  const {
    data: insights,
    error: insErr,
    loading: insLoading,
  } = useJson<InsightsResult>(insightsUrl);
  const {
    data: config,
    error: cfgErr,
    loading: cfgLoading,
  } = useJson<RunConfig>(configUrl);

  const loading = insLoading || cfgLoading;
  const error = insErr ?? cfgErr;

  return (
    <>
      <div className="page-header">
        <h1>Insights</h1>
        <p>
          Where you stand across the buyer-intent prompts: mention heatmap,
          citation leaderboard, share of voice, and who shows up with you.
        </p>
      </div>

      <ConfigPicker />

      {!selected && (
        <div className="empty">Select a config to view its insights.</div>
      )}
      {selected && loading && <Loading label="Loading insights…" />}
      {selected && !loading && error && (
        <ErrorNote message={`Could not load insights for "${selected}": ${error}`} />
      )}

      {selected && !loading && !error && insights && config && (
        insights.totalSamples === 0 ? (
          <div className="empty">
            No results yet for <strong>{selected}</strong>. Head to the{" "}
            <a href={ROUTES.run}>Run</a> screen to measure this config — insights
            appear here once a run completes.
          </div>
        ) : (
          <InsightsView insights={insights} config={config} configName={selected} />
        )
      )}
    </>
  );
}

function InsightsView({
  insights,
  config,
  configName,
}: {
  insights: InsightsResult;
  config: RunConfig;
  configName: string;
}) {
  const clientName = insights.client.name;

  // --- Provider columns: config.models keys first (so an enabled-but-empty
  //     provider still shows), then any extra provider present only in the data.
  const configProviders = Object.keys(config.models) as Provider[];
  const providerCols: Provider[] = [...configProviders];
  for (const c of insights.matrix) {
    if (!providerCols.includes(c.provider)) providerCols.push(c.provider);
  }

  return (
    <>
      <Section title="Overview">
        <div className="estimate">
          <div className="stat">
            <span className="num">{count(insights.totalSamples)}</span>
            <span className="cap">Samples analyzed</span>
          </div>
          <div className="stat">
            <span className="num">{count(providerCols.length)}</span>
            <span className="cap">Providers</span>
          </div>
          <div className="stat">
            <span className="num">{count(insights.flakyCount)}</span>
            <span className="cap">Flaky groups</span>
          </div>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Prompt-set <span className="badge badge-version">{insights.promptSetVersion}</span>.
          Every cell shows raw samples (x/n): insights count all completed
          samples, with no ≥3-sample sufficiency rule, so a small cell may
          differ from the rendered report.
        </p>
      </Section>

      <Heatmap
        insights={insights}
        config={config}
        configName={configName}
        providerCols={providerCols}
        clientName={clientName}
      />
      <DomainLeaderboard insights={insights} />
      <ShareOfVoice
        insights={insights}
        providerCols={providerCols}
        clientName={clientName}
      />
      <CoOccurrence insights={insights} clientName={clientName} />
    </>
  );
}

// --------------------------------------------------------------------------
// 1. Prompt × provider mention heatmap
// --------------------------------------------------------------------------
function Heatmap({
  insights,
  config,
  configName,
  providerCols,
  clientName,
}: {
  insights: InsightsResult;
  config: RunConfig;
  configName: string;
  providerCols: Provider[];
  clientName: string;
}) {
  // Expansion keyed by promptText (NOT prompt.id): ids regenerate on any text
  // edit, so promptText is the stable identity the answers join on too.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (promptText: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(promptText)) next.delete(promptText);
      else next.add(promptText);
      return next;
    });
  // (promptText × provider) → MatrixCell for O(1) lookup.
  const byKey = new Map<string, MatrixCell>();
  for (const c of insights.matrix) byKey.set(`${c.provider}\u0000${c.promptText}`, c);

  // Rows: config prompt order (matrix preserves results-file order — reorder
  // here), grouped by category preserving first-appearance order.
  const groups: { category: string; prompts: { id: string; text: string }[] }[] = [];
  const groupIdx = new Map<string, number>();
  for (const p of config.promptSet.prompts) {
    const cat = p.category && p.category.trim().length > 0 ? p.category : "Uncategorized";
    let idx = groupIdx.get(cat);
    if (idx === undefined) {
      idx = groups.length;
      groupIdx.set(cat, idx);
      groups.push({ category: cat, prompts: [] });
    }
    groups[idx]!.prompts.push({ id: p.id, text: p.text });
  }

  const totalCols = providerCols.length + 1;

  return (
    <Section
      title="Mention heatmap"
      desc={`How often ${clientName} is named in each prompt × provider group. Each cell shows mentions / samples; a dot marks a flaky (inconsistent) group.`}
    >
      <div className="table-wrap">
        <table className="heatmap">
          <thead>
            <tr>
              <th className="prompt-col" scope="col">
                Prompt
              </th>
              {providerCols.map((p) => (
                <th key={p} scope="col">
                  {providerLabel(p)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.category}>
                <tr className="cat-row">
                  <th colSpan={totalCols} scope="colgroup">
                    {g.category}
                  </th>
                </tr>
                {g.prompts.map((prompt) => {
                  const isOpen = expanded.has(prompt.text);
                  return (
                    <Fragment key={prompt.id}>
                      <tr
                        className={`prompt-row${isOpen ? " is-open" : ""}`}
                        onClick={() => toggle(prompt.text)}
                        aria-expanded={isOpen}
                      >
                        <th className="prompt-col" scope="row">
                          <button
                            type="button"
                            className="prompt-toggle"
                            aria-expanded={isOpen}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(prompt.text);
                            }}
                          >
                            <span className="prompt-caret" aria-hidden="true">
                              {isOpen ? "▾" : "▸"}
                            </span>
                            <span>{prompt.text}</span>
                          </button>
                        </th>
                        {providerCols.map((p) => {
                      const cell = byKey.get(`${p}\u0000${prompt.text}`);
                      if (!cell) {
                        return (
                          <td key={p} className="hm-cell hm-empty" title="No samples yet">
                            —
                          </td>
                        );
                      }
                      const st = heatStyle(cell.client.fraction);
                      return (
                        <td
                          key={p}
                          className="hm-cell"
                          style={st}
                          title={`${clientName} mentioned in ${cell.client.mentions} of ${cell.samples} samples (${Math.round(
                            cell.client.fraction * 100,
                          )}%)${cell.flaky ? " — flaky" : ""}`}
                        >
                          {count(cell.client.mentions)}/{count(cell.samples)}
                          {cell.flaky && (
                            <span
                              className="flaky-dot"
                              style={{ background: FLAKY_AMBER }}
                              aria-hidden="true"
                            />
                          )}
                        </td>
                      );
                    })}
                      </tr>
                      {isOpen && (
                        <tr className="answer-row">
                          <td className="answer-cell" colSpan={totalCols}>
                            <PromptDetail
                              configName={configName}
                              promptId={prompt.id}
                              clientName={clientName}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Cell text is <strong>mentions / samples</strong>. Darker = mentioned more
        often. A <span className="flaky-inline" style={{ background: FLAKY_AMBER }} />{" "}
        dot flags a flaky group ({clientName} named in some samples but not all).
      </p>
    </Section>
  );
}

// --------------------------------------------------------------------------
// 2. Citation-domain leaderboard (top 15, horizontal bars)
// --------------------------------------------------------------------------
function DomainLeaderboard({ insights }: { insights: InsightsResult }) {
  const rows = insights.domainLeaderboard.overall.slice(0, 15);
  const max = rows.length > 0 ? rows[0]!.count : 0; // sorted desc by count

  return (
    <Section
      title="Citation-domain leaderboard"
      desc="Domains the models cited across all answers, by citation count (occurrences, not % of runs). Top 15."
    >
      {rows.length === 0 ? (
        <div className="empty">No citations recorded in these results yet.</div>
      ) : (
        <div className="hbars">
          {rows.map((r) => {
            const isClient = r.isClient;
            const isCompetitor = !isClient && r.competitors.length > 0;
            const fill = isClient
              ? "var(--accent)"
              : isCompetitor
                ? COMPETITOR_RED
                : "var(--border)";
            const width = pct(r.count, max);
            return (
              <div className="hbar-row" key={r.domain}>
                <div className="hbar-label">
                  <span className="mono small">{r.domain}</span>
                  {isClient && <span className="badge badge-ok">you</span>}
                  {isCompetitor && (
                    <span className="badge badge-comp" title={r.competitors.join(", ")}>
                      competitor
                    </span>
                  )}
                </div>
                <div className="hbar-track">
                  <span
                    className="hbar-fill"
                    style={{ width: `${width}%`, background: fill }}
                  />
                </div>
                <span className="hbar-value">{count(r.count)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// --------------------------------------------------------------------------
// 3. Share of voice (overall % + per-provider mini-bars)
// --------------------------------------------------------------------------
function ShareOfVoice({
  insights,
  providerCols,
  clientName,
}: {
  insights: InsightsResult;
  providerCols: Provider[];
  clientName: string;
}) {
  const sov = insights.shareOfVoice;
  const overallPct = Math.round(sov.overall.share * 100);

  // Fall back to config-derived providerCols so an enabled-but-empty provider
  // still shows a (0%) bar rather than vanishing.
  const byProvider = new Map(sov.byProvider.map((x) => [x.provider, x.sov]));

  return (
    <Section
      title="Share of voice"
      desc={`${clientName}'s mentions as a share of all brand mentions (${clientName} + curated competitors) across the answers.`}
    >
      <div className="sov">
        <div className="sov-hero">
          <span className="sov-num">{overallPct}%</span>
          <span className="cap">
            {count(sov.overall.clientMentions)} of {count(sov.overall.totalMentions)}{" "}
            brand mentions were {clientName}
          </span>
        </div>
        <div className="sov-providers">
          {providerCols.map((p) => {
            const s = byProvider.get(p) ?? {
              clientMentions: 0,
              totalMentions: 0,
              share: 0,
            };
            const w = pct(Math.round(s.share * 100), 100);
            return (
              <div className="sov-prov" key={p}>
                <div className="bar-label">
                  <span>{providerLabel(p)}</span>
                  <span>
                    {Math.round(s.share * 100)}% · {count(s.clientMentions)}/
                    {count(s.totalMentions)}
                  </span>
                </div>
                <div className="bar">
                  <span style={{ width: `${w}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

// --------------------------------------------------------------------------
// 4. Co-occurrence table (with-you / instead-of-you per competitor)
// --------------------------------------------------------------------------
function CoOccurrence({
  insights,
  clientName,
}: {
  insights: InsightsResult;
  clientName: string;
}) {
  const rows = insights.coOccurrence;

  return (
    <Section
      title="Competitor co-occurrence"
      desc={`For each curated competitor: answers that name it alongside ${clientName} (“with you”) vs. name it but not ${clientName} (“instead of you”).`}
    >
      {rows.length === 0 ? (
        <div className="empty">
          No competitors curated yet. Promote some on the Curation page to see
          who shows up with or instead of you.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="cooc">
            <thead>
              <tr>
                <th scope="col">Competitor</th>
                <th scope="col">With you</th>
                <th scope="col">Instead of you</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.competitor}>
                  <th scope="row">{r.competitor}</th>
                  <td className="num-cell">{count(r.withClient)}</td>
                  <td className="num-cell">{count(r.withoutClient)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// --------------------------------------------------------------------------
// R3: expandable prompt detail — the ground-truth "read the actual answers"
// panel. Lazy-fetches ONE prompt's OK samples on expand and renders each as a
// card: provider/model/sample header, the full prose with client aliases marked
// in accent + competitor aliases underlined, a citation list, and the
// extractor's discovered brands as chips.
// --------------------------------------------------------------------------
function PromptDetail({
  configName,
  promptId,
  clientName,
}: {
  configName: string;
  promptId: string;
  clientName: string;
}) {
  const { data, error, loading } = useJson<AnswersResponse>(
    API.answersPath(configName, promptId),
  );

  if (loading) return <Loading label="Loading answers…" />;
  if (error)
    return <ErrorNote message={`Could not load answers: ${error}`} />;
  if (!data) return null;

  if (data.cells.length === 0) {
    return (
      <div className="empty">
        No completed samples for this prompt yet. Run this config to see the
        actual AI answers here.
      </div>
    );
  }

  const highlighter = buildHighlighter(data.clientAliases, data.competitorAliases);

  return (
    <div className="answers">
      <p className="answers-note small muted">
        Actual answers for this prompt. <mark className="mention-client">{clientName}</mark>{" "}
        mentions are marked; <span className="mention-comp">curated competitors</span>{" "}
        are underlined. Highlighting is an approximate client-side match, so it
        can differ slightly from the server’s mention detection.
      </p>
      {data.cells.map((cell) => (
        <article className="answer-card" key={`${cell.provider}-${cell.model}-${cell.sampleIndex}`}>
          <header className="answer-head">
            <span className="answer-provider">{providerLabel(cell.provider)}</span>
            <span className="mono small answer-model">{cell.model}</span>
            <span className="badge answer-sample">sample {cell.sampleIndex}</span>
          </header>
          <div className="answer-prose">{highlight(cell.responseText, highlighter)}</div>

          {cell.brands.length > 0 && (
            <div className="answer-brands">
              <span className="answer-brands-label small muted">Extracted brands:</span>
              {cell.brands.map((b, i) => (
                <span className="chip" key={`${b}-${i}`}>
                  {b}
                </span>
              ))}
            </div>
          )}

          {cell.citations.length > 0 && (
            <div className="answer-citations">
              <span className="answer-brands-label small muted">Citations:</span>
              <ul>
                {cell.citations.map((cit, i) => {
                  const safeUrl = safeHttpUrl(cit.url);
                  const label =
                    cit.title && cit.title.trim().length > 0 ? cit.title : cit.url;
                  return (
                    <li key={`${cit.url}-${i}`}>
                      {safeUrl ? (
                        <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                          {label}
                        </a>
                      ) : (
                        // Non-http(s) scheme: render the label as plain text, no anchor.
                        <span>{label}</span>
                      )}
                      {cit.domain && (
                        <span className="badge cite-domain mono">{cit.domain}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// Client-side mention highlighting. MIRRORS backend/core/shared/normalize.ts:
// matches are word-boundary (not flanked by an alphanumeric) over the SAME
// aliases the server matches, and each match is classified by re-normalizing it
// and testing set membership. Segments between matches are plain text and every
// segment is a React child (escaped) — NEVER injected HTML. Because the match
// runs on RAW prose rather than the server's normalized form, it is approximate
// (surfaced via the "approximate" note in the panel).
// --------------------------------------------------------------------------

/** Mirror of normalizeText (backend/core/shared/normalize.ts) for classifying a match. */
function normForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9.\s]/g, " ") // punctuation → space (keep dots for domains)
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Highlighter {
  re: RegExp;
  clientSet: ReadonlySet<string>;
  compSet: ReadonlySet<string>;
}

function buildHighlighter(
  clientAliases: string[],
  competitorAliases: string[],
): Highlighter | null {
  const clientSet = new Set(clientAliases.map(normForMatch).filter((a) => a.length > 0));
  const compSet = new Set(competitorAliases.map(normForMatch).filter((a) => a.length > 0));

  const raw = [...clientAliases, ...competitorAliases]
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const uniq = Array.from(new Set(raw)).sort((a, b) => b.length - a.length); // longest first
  if (uniq.length === 0) return null;

  // Escape each alias, then let inner whitespace flex (normalize collapses runs
  // of whitespace, so "Socially Powerful" should match across a newline too).
  const pattern = uniq.map((a) => escapeRegExp(a).replace(/\s+/g, "\\s+")).join("|");
  // Word boundary ≈ not flanked by an alphanumeric — the normalize rule renders
  // every other char a separator. A trailing dot/punct is therefore allowed.
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![A-Za-z0-9])`, "gi");
  return { re, clientSet, compSet };
}

function highlight(text: string, hl: Highlighter | null): ReactNode {
  if (!hl) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  hl.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = hl.re.exec(text)) !== null) {
    const matched = m[0];
    if (m.index > last) out.push(text.slice(last, m.index));
    const norm = normForMatch(matched);
    if (hl.clientSet.has(norm)) {
      out.push(
        <mark
          key={key++}
          className="mention-client"
          title="Client mention (approximate client-side match)"
        >
          {matched}
        </mark>,
      );
    } else if (hl.compSet.has(norm)) {
      out.push(
        <span
          key={key++}
          className="mention-comp"
          title="Competitor mention (approximate client-side match)"
        >
          {matched}
        </span>,
      );
    } else {
      out.push(matched);
    }
    last = m.index + matched.length;
    if (m.index === hl.re.lastIndex) hl.re.lastIndex++; // guard against zero-length
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
