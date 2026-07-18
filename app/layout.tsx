/**
 * Cockpit app shell — minimal nav + page frame. The pages themselves
 * (/clients, /run, /prompts, /curation, /reports) belong to Lane B; this only
 * links to them. Route paths come from the shared contract so nav and API stay
 * in lockstep.
 */
import type { ReactNode } from "react";
import { ROUTES } from "./lib/contract";
import Nav from "./components/Nav";
import "./globals.css";

export const metadata = {
  title: "enkidu cockpit",
  description: "Founder-only local control panel for the AI Visibility Report pipeline",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <span className="brand">
            <a href={ROUTES.home}>enkidu cockpit</a>
          </span>
          {/* R9: nav links live in a tiny client child so the active route can be
              highlighted (usePathname). The layout itself stays a server component. */}
          <Nav />
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
