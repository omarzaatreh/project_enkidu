"use client";

/**
 * R9: the cockpit nav links as a tiny client component so the current route can
 * be highlighted via usePathname(). Deliberately split out of layout.tsx (which
 * stays a SERVER component) — only the links opt into the client, not the whole
 * shell. Items + order come verbatim from the shared ROUTES contract (Clients,
 * Run, Prompts, Insights, Curation, Reports — including R2's Insights entry).
 */
import { usePathname } from "next/navigation";
import { ROUTES } from "../lib/contract";

const NAV = [
  { href: ROUTES.clients, label: "Clients" },
  { href: ROUTES.run, label: "Run" },
  { href: ROUTES.prompts, label: "Prompts" },
  { href: ROUTES.insights, label: "Insights" },
  { href: ROUTES.curation, label: "Curation" },
  { href: ROUTES.reports, label: "Reports" },
];

export default function Nav() {
  const pathname = usePathname() ?? "";
  return (
    <>
      {NAV.map((item) => {
        // Exact match, or a nested route under this section (e.g. /reports/x).
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <a
            key={item.href}
            href={item.href}
            className={active ? "active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </a>
        );
      })}
    </>
  );
}
