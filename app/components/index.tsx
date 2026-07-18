"use client";

/**
 * Small shared cockpit primitives: Section, Field, ErrorNote, Spinner, plus a
 * few state helpers (Loading, Empty). Deliberately plain — styling lives in
 * globals.css.
 */
import type { ReactNode } from "react";

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
