/**
 * Cockpit app shell — minimal nav + page frame. The pages themselves
 * (/clients, /run, /prompts, /curation, /reports) belong to Lane B; this only
 * links to them. Route paths come from the shared contract so nav and API stay
 * in lockstep.
 */
import type { ReactNode } from "react";
import { ROUTES } from "./lib/contract";
import "./globals.css";

export const metadata = {
  title: "enkidu cockpit",
  description: "Founder-only local control panel for the AI Visibility Report pipeline",
};

const NAV = [
  { href: ROUTES.clients, label: "Clients" },
  { href: ROUTES.run, label: "Run" },
  { href: ROUTES.prompts, label: "Prompts" },
  { href: ROUTES.curation, label: "Curation" },
  { href: ROUTES.reports, label: "Reports" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <span className="brand">
            <a href={ROUTES.home}>enkidu cockpit</a>
          </span>
          {NAV.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
