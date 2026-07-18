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
  type OutageResponse,
  type RenderResponse,
  ROUTES,
} from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Loading, OutagePanel, Section } from "../components/index";
import { count } from "../lib/format";

export default function CurationPage() {
  const [selected] = useSelectedConfig();
  const url = selected ? API.curationPath(selected) : null;
  const { data, error, loading, reload } = useJson<CurationResponse>(url);

  const candidates = data?.candidates ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Reset the selection whenever the candidate list changes.
  useEffect(() => {
    setPicked(new Set());
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

  // Free re-render after curation.
  const [renderState, setRenderState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "done"; reportFile: string }
    | { status: "outage"; providers: string[]; completion: OutageResponse["completion"] }
    | { status: "error"; message: string }
  >({ status: "idle" });

  async function reRender(acknowledgeOutage = false) {
    if (!selected) return;
    setRenderState({ status: "sending" });
    const res = await sendJson<RenderResponse>(API.render, "POST", {
      configName: selected,
      acknowledgeOutage,
    });
    if (res.ok && res.data) {
      setRenderState({ status: "done", reportFile: res.data.reportFile });
      return;
    }
    if (res.status === 409) {
      const body = res.errorBody as OutageResponse | null;
      setRenderState({
        status: "outage",
        providers: body?.outageProviders ?? [],
        completion: body?.completion ?? [],
      });
      return;
    }
    setRenderState({ status: "error", message: res.error ?? "render failed" });
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
                  onClick={() => setPicked(new Set(candidates.map((c) => c.name)))}
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
              <div>
                {candidates.map((c) => (
                  <label className="check-row" key={c.name}>
                    <input
                      type="checkbox"
                      checked={picked.has(c.name)}
                      onChange={() => toggle(c.name)}
                    />
                    <span className="count">{count(c.count)}×</span>
                    <span>{c.name}</span>
                  </label>
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

          {renderState.status === "outage" && (
            <OutagePanel
              outageProviders={renderState.providers}
              completion={renderState.completion}
              onRenderAnyway={() => reRender(true)}
              onDismiss={() => setRenderState({ status: "idle" })}
            />
          )}
          {renderState.status === "error" && (
            <ErrorNote message={`Re-render failed: ${renderState.message}`} />
          )}
          {renderState.status === "done" && (
            <div className="info-note">
              Re-rendered <span className="mono">{renderState.reportFile}</span>.{" "}
              <a href={ROUTES.reports}>View it on the Reports page →</a>
            </div>
          )}

          {renderState.status !== "outage" && (
            <div className="toolbar">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => reRender()}
                disabled={renderState.status === "sending"}
              >
                {renderState.status === "sending" ? "Rendering…" : "Re-render report (free)"}
              </button>
            </div>
          )}
          <p className="small muted">
            Re-rendering reuses existing results — no new model calls, no cost.
          </p>
        </Section>
      )}
    </>
  );
}
