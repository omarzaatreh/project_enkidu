"use client";

/**
 * /curation — discovered-competitor candidates as checkbox rows. Select some,
 * Promote them into config.competitors, then re-render the report for free.
 */
import { useEffect, useState } from "react";
import {
  API,
  type CurationPromoteResponse,
  type CurationResponse,
  ROUTES,
} from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Loading, Section } from "../components/index";
import { RenderButton } from "../components/RenderButton";
import { count } from "../lib/format";

export default function CurationPage() {
  const [selected] = useSelectedConfig();
  const url = selected ? API.curationPath(selected) : null;
  const { data, error, loading, reload } = useJson<CurationResponse>(url);

  const candidates = data?.candidates ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Hide 1-mention candidates to cut extractor noise. Defaults ON only when the
  // list is long enough (~20) that the noise is worth hiding by default.
  const [hideSingles, setHideSingles] = useState(false);
  const singleCount = candidates.filter((c) => c.count === 1).length;
  const visible = hideSingles ? candidates.filter((c) => c.count > 1) : candidates;

  // Reset the selection + toggle default whenever the candidate list changes.
  useEffect(() => {
    setPicked(new Set());
    setHideSingles((data?.candidates?.length ?? 0) > 20);
  }, [data]);

  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [result, setResult] = useState<{ competitors: number; promoted: number } | null>(null);

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function promote() {
    if (!selected || picked.size === 0) return;
    const list = [...picked];
    setPromoting(true);
    setPromoteError(null);
    const res = await sendJson<CurationPromoteResponse>(API.curationPromote, "POST", {
      configName: selected,
      promote: list,
    });
    setPromoting(false);
    if (!res.ok) {
      setPromoteError(res.error);
      return;
    }
    setResult({ competitors: res.data?.competitors ?? 0, promoted: list.length });
    reload();
  }

  return (
    <>
      <div className="page-header">
        <h1>Curation</h1>
        <p>Promote real competitors discovered in the model answers into the config.</p>
      </div>

      <ConfigPicker />

      {!selected && <div className="empty">Select a config to review its candidates.</div>}
      {selected && loading && <Loading label="Loading candidates…" />}
      {selected && error && (
        <ErrorNote message={`Could not load candidates: ${error}`} />
      )}

      {selected && !loading && !error && (
        <Section
          title="Discovered candidates"
          desc="Brands named across the answers, minus ones already curated — sorted by mention count."
          right={
            candidates.length > 0 ? (
              <div className="toolbar">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPicked(new Set(visible.map((c) => c.name)))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPicked(new Set())}
                >
                  Select none
                </button>
              </div>
            ) : undefined
          }
        >
          {candidates.length === 0 ? (
            <div className="empty">
              No candidates yet. Run the pipeline first — discovered competitors appear here.
            </div>
          ) : (
            <>
              {singleCount > 0 && (
                <label
                  className="small muted"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={hideSingles}
                    onChange={() => setHideSingles((v) => !v)}
                  />
                  Hide 1-mention candidates ({count(singleCount)} hidden)
                </label>
              )}
              <div>
                {visible.map((c) => (
                  <div
                    key={c.name}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      padding: "0.5rem 0.2rem",
                    }}
                  >
                    <label
                      className="check-row"
                      style={{ borderBottom: "none", padding: 0, flexWrap: "wrap" }}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(c.name)}
                        onChange={() => toggle(c.name)}
                      />
                      <span className="count">{count(c.count)}×</span>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                      {c.providers.map((p) => (
                        <span key={p} className="badge badge-version">
                          {p}
                        </span>
                      ))}
                      {c.promptIds.length > 0 && (
                        <span className="small muted">
                          in {count(c.promptIds.length)}{" "}
                          {c.promptIds.length === 1 ? "prompt" : "prompts"}
                        </span>
                      )}
                    </label>
                    {c.exampleSnippet && (
                      <p
                        className="small muted"
                        style={{ margin: "0.3rem 0 0", paddingLeft: "1.9rem" }}
                      >
                        “{c.exampleSnippet}”
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <div className="toolbar" style={{ marginTop: "1rem" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={promote}
                  disabled={promoting || picked.size === 0}
                >
                  {promoting ? "Promoting…" : `Promote ${count(picked.size)} selected`}
                </button>
              </div>
              {promoteError && <ErrorNote message={`Promote failed: ${promoteError}`} />}
            </>
          )}
        </Section>
      )}

      {result && (
        <Section title="Promoted">
          <div className="info-note">
            Promoted {count(result.promoted)}{" "}
            {result.promoted === 1 ? "competitor" : "competitors"}. The config now tracks{" "}
            <strong>{count(result.competitors)}</strong> competitors.
          </div>

          <RenderButton
            configName={selected}
            label="Re-render report (free)"
            errorLabel="Re-render failed"
            renderDone={(reportFile) => (
              <div className="info-note">
                Re-rendered <span className="mono">{reportFile}</span>.{" "}
                <a href={ROUTES.reports}>View it on the Reports page →</a>
              </div>
            )}
          />
          <p className="small muted">
            Re-rendering reuses existing results — no new model calls, no cost.
          </p>
        </Section>
      )}
    </>
  );
}
