"use client";

/**
 * Small shared cockpit primitives: Section, Field, ErrorNote, Spinner, plus a
 * few state helpers (Loading, Empty). Deliberately plain — styling lives in
 * globals.css.
 */
import type { ReactNode } from "react";
import { count, pct } from "../lib/format";
import type { OutageResponse } from "../lib/contract";

export function Section({
  title,
  desc,
  right,
  children,
}: {
  title?: string;
  desc?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      {(title || right) && (
        <div className="item-head" style={{ marginBottom: desc ? "0.25rem" : "0.75rem" }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {right}
        </div>
      )}
      {desc && <p className="section-desc">{desc}</p>}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div className="error-note" role="alert">
      {message}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-row">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * Explains an outage-blocked render instead of showing a bare error. Shows each
 * enabled provider's "X of Y samples complete (Z%)" and three clearly-labeled
 * actions: render anyway (incomplete), a resume hint, and dismiss. All divisions
 * are guarded (format.pct) so a zero planned count never renders NaN.
 */
export function OutagePanel({
  outageProviders,
  completion,
  onRenderAnyway,
  onDismiss,
  busy = false,
}: {
  outageProviders: string[];
  completion: OutageResponse["completion"];
  onRenderAnyway: () => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const rows = completion ?? [];
  return (
    <div className="warn-note" role="alert">
      <strong>Render blocked — incomplete data.</strong>{" "}
      {outageProviders.length > 0 ? (
        <span>
          Below the completion threshold:{" "}
          <strong>{outageProviders.join(", ")}</strong>.
        </span>
      ) : (
        <span>One or more providers are below the completion threshold.</span>
      )}

      {rows.length > 0 && (
        <ul style={{ margin: "0.5rem 0 0.25rem", paddingLeft: "1.1rem" }}>
          {rows.map((r) => (
            <li key={r.provider} className="small">
              <strong>{r.provider}</strong>: {count(r.completed)} of {count(r.planned)} samples
              complete ({Math.round(pct(r.completed, r.planned))}%)
            </li>
          ))}
        </ul>
      )}

      <p className="small" style={{ margin: "0.5rem 0" }}>
        Resume the run to finish, or lower samples per prompt on the Run screen.
      </p>

      <div className="toolbar">
        <button type="button" className="btn btn-primary" onClick={onRenderAnyway} disabled={busy}>
          {busy ? "Rendering…" : "Render anyway (incomplete)"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDismiss} disabled={busy}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
