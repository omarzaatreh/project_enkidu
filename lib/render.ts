/**
 * Report renderer — the product's entire user-facing surface.
 *
 * Pure function: AggregateResult + RunConfig → one self-contained HTML
 * document (inline CSS, system fonts, no external assets). Designed as an
 * editorial consultancy report an agency can forward to a brand client.
 */

import type {
  AggregateResult,
  CitationGapRow,
  CompetitorStat,
  ModelStats,
  Provider,
  RunConfig,
  TrendPoint,
} from "./types.js";

const PROVIDER_DISPLAY_NAMES: Record<Provider, string> = {
  openai: "ChatGPT",
  anthropic: "Claude",
  perplexity: "Perplexity",
};

/** Escape untrusted text for interpolation into HTML (element and attribute contexts). */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "70%" — or "—" when the denominator is zero. Never NaN. */
function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

// ---------- Sections ----------

function renderHeader(config: RunConfig): string {
  const { whiteLabel, client, dateRange } = config;
  const brand = whiteLabel.logoUrl
    ? `<img class="agency-logo" src="${htmlEscape(whiteLabel.logoUrl)}" alt="${htmlEscape(whiteLabel.agencyName)}">`
    : `<span class="agency-name">${htmlEscape(whiteLabel.agencyName)}</span>`;
  return `<header class="report-header">
  <div class="agency-brand">${brand}</div>
  <h1>AI Visibility Report</h1>
  <p class="subtitle">Prepared for ${htmlEscape(client.name)} &middot; ${htmlEscape(dateRange.from)} &ndash; ${htmlEscape(dateRange.to)}</p>
</header>`;
}

function renderModelCard(stats: ModelStats): string {
  const displayName = PROVIDER_DISPLAY_NAMES[stats.provider];
  const mentionPct = pct(stats.mentionRuns, stats.completedRuns);
  const citedPct = pct(stats.citedRuns, stats.completedRuns);
  return `<div class="stat-card">
      <div class="stat-provider">${htmlEscape(displayName)}</div>
      <div class="stat-model">${htmlEscape(stats.model)}</div>
      <div class="stat-big">${mentionPct}</div>
      <div class="stat-honest">appeared in ${stats.mentionRuns} of ${stats.completedRuns} runs</div>
      <div class="stat-cited"><span class="stat-cited-label">Cited as a source:</span> ${citedPct} (${stats.citedRuns} of ${stats.completedRuns})</div>
    </div>`;
}

function renderHero(agg: AggregateResult): string {
  const cards = agg.perModel.map(renderModelCard).join("\n    ");
  const zeroMention =
    agg.perModel.length > 0 && agg.perModel.every((m) => m.mentionRuns === 0);
  const framing = zeroMention
    ? `\n  <p class="zero-mention-framing">${htmlEscape(agg.client.name)} did not appear in AI answers during this period &mdash; the sections below show who appears instead and where AI systems source their information.</p>`
    : "";
  return `<section class="hero">
  <div class="stat-row">
    ${cards}
  </div>${framing}
</section>`;
}

function renderCompetitors(agg: AggregateResult): string {
  const competitors = agg.competitors;
  const heading = `<h2>Who appears instead of you</h2>`;
  const isEmpty =
    competitors.length === 0 ||
    competitors.every((c) => c.isClient && c.mentions === 0);
  if (isEmpty) {
    return `<section class="competitors">
  ${heading}
  <p class="empty-state">No competitor brands were detected in AI answers during this period.</p>
</section>`;
  }
  const maxMentions = Math.max(
    1,
    ...competitors.map((c: CompetitorStat) => c.mentions),
  );
  const rows = competitors
    .map((c) => {
      const width = ((c.mentions / maxMentions) * 100).toFixed(1);
      const youTag = c.isClient ? ` <span class="you-tag">(you)</span>` : "";
      const rowClass = c.isClient ? "bar-row bar-you" : "bar-row";
      return `<div class="${rowClass}">
      <div class="bar-label">${htmlEscape(c.name)}${youTag}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      <div class="bar-count">${c.mentions}</div>
    </div>`;
    })
    .join("\n    ");
  return `<section class="competitors">
  ${heading}
  <div class="bar-chart">
    ${rows}
  </div>
</section>`;
}

function renderGapRow(row: CitationGapRow): string {
  const rowClass = row.clientCited ? "gap-row" : "gap-row gap-miss";
  const title = row.exampleTitle
    ? `<div class="gap-title">${htmlEscape(row.exampleTitle)}</div>`
    : "";
  const cited = row.clientCited ? "Yes" : "<strong>No</strong>";
  const competitorsCited =
    row.competitorsCited.length > 0
      ? row.competitorsCited.map(htmlEscape).join(", ")
      : "—";
  return `<tr class="${rowClass}">
        <td><span class="gap-domain">${htmlEscape(row.domain)}</span>${title}</td>
        <td>${competitorsCited}</td>
        <td class="gap-cited">${cited}</td>
      </tr>`;
}

function renderCitationGaps(agg: AggregateResult): string {
  const heading = `<h2>Where the AIs get their information &mdash; and you&rsquo;re missing</h2>`;
  if (agg.citationGaps.length === 0) {
    return `<section class="citation-gaps">
  ${heading}
  <p class="empty-state">No citation gaps were identified during this period.</p>
</section>`;
  }
  const rows = agg.citationGaps.map(renderGapRow).join("\n      ");
  return `<section class="citation-gaps">
  ${heading}
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Source</th><th>Competitors cited there</th><th>You cited?</th></tr>
      </thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

function renderTrend(trend: TrendPoint[]): string {
  if (trend.length < 2) return "";
  const width = 640;
  const height = 180;
  const padX = 24;
  const padTop = 28;
  const padBottom = 36;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  const rates = trend.map((t) => t.overallMentionRate);
  const maxRate = Math.max(...rates);
  const yMax = maxRate > 0 ? maxRate * 1.25 : 1;
  const x = (i: number): number =>
    padX + (i * (width - padX * 2)) / (trend.length - 1);
  const y = (rate: number): number =>
    padTop + (height - padTop - padBottom) * (1 - rate / yMax);
  const points = trend
    .map((t, i) => `${x(i).toFixed(1)},${y(t.overallMentionRate).toFixed(1)}`)
    .join(" ");
  const dots = trend
    .map(
      (t, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(t.overallMentionRate).toFixed(1)}" r="3.5" class="trend-dot"/>`,
    )
    .join("");
  const firstPctLabel = `<text x="${x(0).toFixed(1)}" y="${(y(first.overallMentionRate) - 10).toFixed(1)}" text-anchor="start" class="trend-value">${Math.round(first.overallMentionRate * 100)}%</text>`;
  const lastPctLabel = `<text x="${x(trend.length - 1).toFixed(1)}" y="${(y(last.overallMentionRate) - 10).toFixed(1)}" text-anchor="end" class="trend-value">${Math.round(last.overallMentionRate * 100)}%</text>`;
  const baselineY = (height - padBottom).toFixed(1);
  return `<section class="trend">
  <h2>Mention rate over time</h2>
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Overall mention rate over time" preserveAspectRatio="xMidYMid meet">
    <line x1="${padX}" y1="${baselineY}" x2="${width - padX}" y2="${baselineY}" class="trend-baseline"/>
    <polyline points="${points}" class="trend-line"/>
    ${dots}
    ${firstPctLabel}
    ${lastPctLabel}
    <text x="${padX}" y="${height - 10}" text-anchor="start" class="trend-date">${htmlEscape(first.date)}</text>
    <text x="${width - padX}" y="${height - 10}" text-anchor="end" class="trend-date">${htmlEscape(last.date)}</text>
  </svg>
</section>`;
}

function renderMethodology(agg: AggregateResult, config: RunConfig): string {
  const modelList = (Object.keys(config.models) as Provider[])
    .map(
      (provider) =>
        `${htmlEscape(PROVIDER_DISPLAY_NAMES[provider])}: ${htmlEscape(config.models[provider])} (web search grounded)`,
    )
    .join(" &middot; ");
  const insufficient = agg.perModel.filter((m) => m.insufficientPrompts > 0);
  const insufficientLine =
    insufficient.length > 0
      ? `\n  <p>Prompts excluded for insufficient samples: ${insufficient
          .map(
            (m) =>
              `${htmlEscape(PROVIDER_DISPLAY_NAMES[m.provider])} (${htmlEscape(m.model)}): ${m.insufficientPrompts}`,
          )
          .join("; ")}.</p>`
      : "";
  return `<footer class="methodology">
  <h2>Methodology</h2>
  <p>Models: ${modelList}.</p>
  <p>Prompt set version ${htmlEscape(agg.promptSetVersion)} &middot; ${config.samplesPerPrompt} samples per prompt &middot; ${agg.totalCompleted} of ${agg.totalPlanned} runs completed.</p>${insufficientLine}
  <p>AI answers vary between runs; percentages report observed frequency across samples, not a guarantee of any single answer.</p>
  <p>Measured via provider APIs with web search enabled; consumer apps may differ.</p>
</footer>`;
}

// ---------- Styles ----------

function renderStyles(accentColor: string): string {
  const accent = htmlEscape(accentColor);
  return `<style>
    :root { --accent: ${accent}; --ink: #1c1f23; --muted: #6b7280; --hairline: #e5e2db; --paper: #fdfdfb; --card: #ffffff; --tint: #fdf6f0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.55;
      border-top: 4px solid var(--accent);
    }
    .page { max-width: 860px; margin: 0 auto; padding: 48px 28px 56px; }
    h1, h2, .stat-big { font-family: Georgia, "Times New Roman", serif; font-weight: 400; }
    section, footer { margin-top: 56px; }

    /* Header */
    .report-header { margin-top: 0; }
    .agency-brand { margin-bottom: 28px; }
    .agency-logo { max-height: 40px; max-width: 220px; display: block; }
    .agency-name { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
    h1 { font-size: 40px; letter-spacing: -0.01em; line-height: 1.15; }
    .subtitle { margin-top: 10px; font-size: 15px; color: var(--muted); }
    h2 { font-size: 22px; margin-bottom: 18px; padding-bottom: 10px; border-bottom: 1px solid var(--hairline); }

    /* Hero stat row */
    .stat-row { display: flex; flex-wrap: wrap; gap: 16px; }
    .stat-card {
      flex: 1 1 200px; min-width: 180px;
      background: var(--card); border: 1px solid var(--hairline); border-radius: 6px;
      padding: 20px 22px 18px;
    }
    .stat-provider { font-size: 15px; font-weight: 600; }
    .stat-model { font-size: 11px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
    .stat-big { font-size: 44px; line-height: 1.1; margin-top: 12px; }
    .stat-honest { font-size: 13px; color: var(--muted); margin-top: 4px; }
    .stat-cited { font-size: 12px; color: var(--ink); margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--hairline); }
    .stat-cited-label { color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; display: block; margin-bottom: 2px; }
    .zero-mention-framing { margin-top: 24px; font-size: 16px; max-width: 62ch; }

    /* Competitor bars */
    .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .bar-label { flex: 0 0 170px; font-size: 14px; text-align: right; overflow-wrap: anywhere; }
    .bar-track { flex: 1 1 auto; background: transparent; }
    .bar-fill { height: 18px; background: #c9c4ba; border-radius: 2px; min-width: 2px; }
    .bar-you .bar-fill { background: var(--accent); }
    .bar-you .bar-label { font-weight: 600; }
    .you-tag { color: var(--accent); font-weight: 600; font-size: 12px; }
    .bar-count { flex: 0 0 36px; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

    /* Citation gaps table */
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 480px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; padding: 8px 12px; border-bottom: 1px solid var(--ink); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
    .gap-domain { font-weight: 500; }
    .gap-title { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .gap-miss td { background: var(--tint); }
    .gap-miss .gap-cited strong { color: #a03d2e; }

    /* Trend */
    .trend svg { width: 100%; height: auto; display: block; }
    .trend-line { fill: none; stroke: var(--ink); stroke-width: 2; }
    .trend-dot { fill: var(--ink); }
    .trend-baseline { stroke: var(--hairline); stroke-width: 1; }
    .trend-value { font-size: 13px; fill: var(--ink); }
    .trend-date { font-size: 12px; fill: var(--muted); }

    /* Empty states */
    .empty-state { color: var(--muted); font-size: 15px; }

    /* Methodology */
    .methodology { border-top: 1px solid var(--hairline); padding-top: 24px; }
    .methodology h2 { font-size: 14px; border-bottom: none; padding-bottom: 0; margin-bottom: 10px; font-family: inherit; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .methodology p { font-size: 12px; color: var(--muted); margin-bottom: 6px; max-width: 76ch; }

    @media (max-width: 480px) {
      .page { padding: 32px 18px 40px; }
      h1 { font-size: 30px; }
      .stat-card { flex-basis: 100%; }
      .bar-label { flex-basis: 110px; font-size: 13px; }
    }

    @media print {
      body { background: #ffffff; border-top-color: var(--accent); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page { max-width: none; padding: 0; }
      section, footer, .stat-card, .bar-row, tr { break-inside: avoid; page-break-inside: avoid; }
      .table-scroll { overflow-x: visible; }
      a { color: inherit; text-decoration: none; }
    }
  </style>`;
}

// ---------- Document ----------

export function renderReport(agg: AggregateResult, config: RunConfig): string {
  const parts = [
    renderHeader(config),
    renderHero(agg),
    renderCompetitors(agg),
    renderCitationGaps(agg),
    renderTrend(agg.trend),
    renderMethodology(agg, config),
  ].filter((p) => p.length > 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>AI Visibility Report — ${htmlEscape(config.client.name)}</title>
${renderStyles(config.whiteLabel.accentColor)}
</head>
<body>
<div class="page">
${parts.join("\n\n")}
</div>
</body>
</html>
`;
}
