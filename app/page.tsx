/**
 * Placeholder home page — links into the routes Lane B will build. Intentionally
 * plain; it exists so `npm run ui` serves a real shell and the nav has a root.
 */
import { ROUTES } from "./lib/contract";

const LINKS = [
  { href: ROUTES.clients, label: "Clients", desc: "Client + white-label setup" },
  { href: ROUTES.run, label: "Run", desc: "Run parameters, cost estimate, progress" },
  { href: ROUTES.prompts, label: "Prompts", desc: "Prompt set with auto-versioning" },
  { href: ROUTES.curation, label: "Curation", desc: "Promote discovered competitors" },
  { href: ROUTES.reports, label: "Reports", desc: "Rendered reports + preview" },
];

export default function Home() {
  return (
    <>
      <h1>enkidu cockpit</h1>
      <p>Founder-only local control panel. Pick a screen:</p>
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href}>{l.label}</a> — {l.desc}
          </li>
        ))}
      </ul>
    </>
  );
}
