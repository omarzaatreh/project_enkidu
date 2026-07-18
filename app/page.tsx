/**
 * Cockpit launchpad — describes the workflow order and links into each screen.
 * Server component (static): no data fetching here.
 */
import { ROUTES } from "./lib/contract";

const STEPS = [
  {
    href: ROUTES.clients,
    label: "Clients",
    desc: "Set up the client brand, aliases, white-label, and competitors. This config JSON is the single source of truth for everything below.",
  },
  {
    href: ROUTES.prompts,
    label: "Prompts",
    desc: "Write the buying-intent prompts. The prompt-set version auto-bumps on any edit; only changed prompts re-run (content-hash resume).",
  },
  {
    href: ROUTES.run,
    label: "Run",
    desc: "Pick providers and samples, preview the cost estimate (marginal vs full), then Run. Live progress streams generation and extraction.",
  },
  {
    href: ROUTES.insights,
    label: "Insights",
    desc: "See where you stand: the prompt × provider mention heatmap, citation-domain leaderboard, share of voice, and who shows up with or instead of you.",
  },
  {
    href: ROUTES.curation,
    label: "Curation",
    desc: "Review discovered competitors by mention count and promote the real ones into the config. Re-rendering after curation is free.",
  },
  {
    href: ROUTES.reports,
    label: "Reports",
    desc: "Preview rendered reports and open them full-screen.",
  },
];

export default function Home() {
  return (
    <>
      <div className="page-header">
        <h1>enkidu cockpit</h1>
        <p>
          Founder-only local control panel for the AI-visibility pipeline. Work
          top to bottom:
        </p>
      </div>
      <ol className="launchpad">
        {STEPS.map((s) => (
          <li key={s.href}>
            <div className="lp-body">
              <a href={s.href}>{s.label}</a>
              <p>{s.desc}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="muted small">
        Runs, reports, and API keys stay on this machine — the server binds
        localhost only.
      </p>
    </>
  );
}
