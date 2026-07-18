"use client";

/**
 * /run — the founder's "press Run instead of editing JSON" screen.
 *  - provider checkboxes with pinned model IDs (from config.models)
 *  - samplesPerPrompt (min 3, with rationale)
 *  - resume-aware cost estimate (marginal vs full)
 *  - Run button, lock-aware and 409-aware
 *  - live SSE progress with a terminal Render (outage-acknowledge) flow
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  API,
  type ActiveRunResponse,
  type EstimateResponse,
  type OutageResponse,
  type ProgressEvent,
  type Provider,
  type PutConfigResponse,
  type RenderResponse,
  type RunConfig,
  ROUTES,
} from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import { PER_CALL_USD } from "../lib/pricing";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Field, Loading, Section } from "../components/index";
import { count, pct, usd, when } from "../lib/format";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const PROVIDERS: { key: Provider; label: string; defaultModel: string }[] = [
  { key: "openai", label: "OpenAI", defaultModel: "gpt-5" },
  { key: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-5" },
  { key: "perplexity", label: "Perplexity", defaultModel: "sonar" },
];

interface ProgressState {
  generation?: { done: number; total: number; failed: number };
  extraction?: { done: number; total: number; failed: number };
  terminal?: { outageProviders: string[] };
}

/** Client-side full-run preview so the founder never sees a blank estimate. */
function localEstimate(cfg: RunConfig): { totalCalls: number; estUsd: number } {
  const providers = Object.keys(cfg.models) as Provider[];
  const prompts = cfg.promptSet.prompts.length;
  const samples = Number.isFinite(cfg.samplesPerPrompt) ? cfg.samplesPerPrompt : 0;
  let totalCalls = 0;
  let gen = 0;
  for (const p of providers) {
    const calls = prompts * samples;
    totalCalls += calls;
    gen += calls * (PER_CALL_USD[p] ?? 0);
  }
  const extraction = totalCalls * PER_CALL_USD.extraction;
  return { totalCalls, estUsd: gen + extraction };
}

export default function RunPage() {
  const [selected] = useSelectedConfig();
  const cfgUrl = selected ? API.config(selected) : null;
  const { data: cfg, error: cfgError, loading: cfgLoading, reload: reloadCfg } =
    useJson<RunConfig>(cfgUrl);

  // Editable run parameters (models + samples), persisted via PUT.
  const [draft, setDraft] = useState<RunConfig | null>(null);
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (cfg) {
      setDraft(clone(cfg));
      setOriginal(JSON.stringify({ models: cfg.models, samples: cfg.samplesPerPrompt }));
    }
  }, [cfg]);

  const dirty =
    draft !== null &&
    JSON.stringify({ models: draft.models, samples: draft.samplesPerPrompt }) !== original;

  function patch(fn: (d: RunConfig) => void) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      return next;
    });
  }

  // Estimate (resume-aware, from disk config). Reloads after a save.
  const estUrl = selected ? API.estimatePath(selected) : null;
  const { data: estimate, error: estError, loading: estLoading, reload: reloadEst } =
    useJson<EstimateResponse>(estUrl);

  // Active-run lock. Polled so the Run button reflects reality.
  const { data: active, reload: reloadActive } =
    useJson<ActiveRunResponse>(API.runsActive);
  useEffect(() => {
    const id = setInterval(reloadActive, 5000);
    return () => clearInterval(id);
  }, [reloadActive]);

  async function saveParams() {
    if (!draft || !selected) return;
    setSaving(true);
    setSaveError(null);
    const res = await sendJson<PutConfigResponse>(API.config(selected), "PUT", draft);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setOriginal(JSON.stringify({ models: draft.models, samples: draft.samplesPerPrompt }));
    reloadCfg();
    reloadEst();
  }

  // --- Run trigger ---------------------------------------------------------
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [watchName, setWatchName] = useState<string | null>(null);
  const [runNonce, setRunNonce] = useState(0);

  const enabledProviders = draft ? (Object.keys(draft.models) as Provider[]) : [];
  const someoneRunning = active?.running === true;
  const runningThis = someoneRunning && active?.configName === selected;

  const runDisabledReason = useMemo(() => {
    if (!selected) return "Select a config first.";
    if (dirty) return "Save your parameters before running.";
    if (enabledProviders.length === 0) return "Enable at least one provider.";
    if (starting) return "Starting…";
    if (someoneRunning)
      return `A run is in progress${active?.configName ? ` (${active.configName})` : ""}.`;
    return null;
  }, [selected, dirty, enabledProviders.length, starting, someoneRunning, active]);

  async function startRun() {
    if (!selected) return;
    setRunError(null);
    setStarting(true);
    const res = await sendJson<{ started: true }>(API.runs, "POST", {
      configName: selected,
    });
    setStarting(false);
    if (!res.ok) {
      if (res.status === 409) {
        reloadActive();
        setRunError("A run is already in progress — see the lock holder above.");
      } else {
        setRunError(res.error);
      }
      return;
    }
    reloadActive();
    setWatchName(selected);
    setRunNonce((n) => n + 1);
  }

  // Auto-attach to progress if a run for this config is already live.
  useEffect(() => {
    if (runningThis && watchName !== selected) {
      setWatchName(selected);
      setRunNonce((n) => n + 1);
    }
  }, [runningThis, watchName, selected]);

  // --- SSE progress --------------------------------------------------------
  const [progress, setProgress] = useState<ProgressState>({});
  const [streamError, setStreamError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!watchName) return;
    setProgress({});
    setStreamError(null);
    doneRef.current = false;

    const es = new EventSource(API.runsProgressPath(watchName));
    esRef.current = es;

    es.onmessage = (ev: MessageEvent) => {
      let frame: ProgressEvent;
      try {
        frame = JSON.parse(ev.data) as ProgressEvent;
      } catch {
        return;
      }
      if (frame.phase === "done") {
        doneRef.current = true;
        setProgress((p) => ({ ...p, terminal: { outageProviders: frame.outageProviders } }));
        es.close();
        reloadActive();
      } else if (frame.phase === "generation") {
        setProgress((p) => ({
          ...p,
          generation: { done: frame.done, total: frame.total, failed: frame.failed },
        }));
      } else {
        setProgress((p) => ({
          ...p,
          extraction: { done: frame.done, total: frame.total, failed: frame.failed },
        }));
      }
    };

    es.onerror = () => {
      if (doneRef.current) return;
      setStreamError("Lost the progress stream. It will resume from disk on reconnect.");
    };

    return () => {
      es.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchName, runNonce]);

  // --- Render --------------------------------------------------------------
  const [ackOutage, setAckOutage] = useState(false);
  const [renderState, setRenderState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "done"; reportFile: string }
    | { status: "outage"; providers: string[] }
    | { status: "error"; message: string }
  >({ status: "idle" });

  async function doRender() {
    if (!selected) return;
    setRenderState({ status: "sending" });
    const res = await sendJson<RenderResponse>(API.render, "POST", {
      configName: selected,
      acknowledgeOutage: ackOutage,
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
      });
      return;
    }
    setRenderState({ status: "error", message: res.error ?? "render failed" });
  }

  const preview = draft ? localEstimate(draft) : null;
  const streaming = !!watchName && !progress.terminal;

  return (
    <>
      <div className="page-header">
        <h1>Run</h1>
        <p>Set parameters, preview the cost, and start a measurement run.</p>
      </div>

      <ConfigPicker />

      {!selected && <div className="empty">Select a config to configure a run.</div>}
      {selected && cfgLoading && <Loading label="Loading config…" />}
      {selected && cfgError && (
        <ErrorNote message={`Could not load "${selected}": ${cfgError}`} />
      )}

      {selected && draft && (
        <>
          <Section title="Providers" desc="Model selection is this list — only enabled providers run.">
            <div className="stack">
              {PROVIDERS.map(({ key, label, defaultModel }) => {
                const enabled = key in draft.models;
                const modelId = draft.models[key] ?? "";
                return (
                  <div className="row" key={key} style={{ alignItems: "center" }}>
                    <label className="inline" style={{ flex: "0 0 10rem" }}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) =>
                          patch((d) => {
                            if (e.target.checked) d.models[key] = defaultModel;
                            else delete d.models[key];
                          })
                        }
                      />
                      <strong>{label}</strong>
                    </label>
                    {enabled ? (
                      <Field label="Pinned model ID">
                        <input
                          type="text"
                          className="mono"
                          value={modelId}
                          onChange={(e) => patch((d) => (d.models[key] = e.target.value))}
                        />
                      </Field>
                    ) : (
                      <span className="small muted">
                        disabled — enabling restores <span className="mono">{defaultModel}</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {enabledProviders.length === 0 && (
              <div className="warn-note">
                No providers enabled — enable at least one to run.
              </div>
            )}
          </Section>

          <Section title="Samples per prompt">
            <Field
              label="Samples per prompt"
              hint="Below 3, every prompt is excluded as insufficient (needs ≥3 completed samples)."
            >
              <input
                type="number"
                min={3}
                value={Number.isFinite(draft.samplesPerPrompt) ? draft.samplesPerPrompt : 3}
                onChange={(e) =>
                  patch((d) => {
                    const n = parseInt(e.target.value, 10);
                    d.samplesPerPrompt = Number.isFinite(n) ? n : 3;
                  })
                }
                style={{ maxWidth: "8rem" }}
              />
            </Field>
            {draft.samplesPerPrompt < 3 && (
              <div className="warn-note">
                {count(draft.samplesPerPrompt)} samples is below 3 — every prompt would be
                excluded as insufficient.
              </div>
            )}
          </Section>

          <div className="toolbar" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={saveParams}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : "Save parameters"}
            </button>
            {dirty && <span className="badge badge-dirty">unsaved changes</span>}
          </div>
          {saveError && <ErrorNote message={`Save failed: ${saveError}`} />}

          <Section title="Cost estimate" desc="Resume-aware: new calls skip cells already completed on disk.">
            {dirty && (
              <div className="info-note">
                Save your parameters to refresh the estimate. Numbers below reflect the
                last saved config.
              </div>
            )}
            {estLoading && <Loading label="Estimating…" />}
            {estError && (
              <div className="warn-note">
                Estimate endpoint unavailable ({estError}). Showing a local full-run preview.
              </div>
            )}
            {estimate ? (
              <>
                <div className="estimate">
                  <div className="stat">
                    <span className="num">{count(estimate.newCalls)}</span>
                    <span className="cap">New calls (marginal)</span>
                  </div>
                  <div className="stat">
                    <span className="num">{count(estimate.totalCalls)}</span>
                    <span className="cap">Total calls (full run)</span>
                  </div>
                  <div className="stat">
                    <span className="num">{usd(estimate.estUsd)}</span>
                    <span className="cap">Est. cost of new calls</span>
                  </div>
                </div>
                {estimate.newCalls < estimate.totalCalls && (
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    Resuming:{" "}
                    {count(estimate.totalCalls - estimate.newCalls)} of{" "}
                    {count(estimate.totalCalls)} calls already completed — you only pay for
                    the {count(estimate.newCalls)} new ones.
                  </p>
                )}
                {estimate.note && <p className="small muted">{estimate.note}</p>}
              </>
            ) : (
              preview && (
                <div className="estimate">
                  <div className="stat">
                    <span className="num">{count(preview.totalCalls)}</span>
                    <span className="cap">Total calls (full run)</span>
                  </div>
                  <div className="stat">
                    <span className="num">{usd(preview.estUsd)}</span>
                    <span className="cap">Est. full-run cost</span>
                  </div>
                </div>
              )
            )}
          </Section>

          <Section title="Start run">
            {someoneRunning && (
              <div className="warn-note">
                Run in progress
                {active?.configName ? (
                  <>
                    {" "}
                    on <strong>{active.configName}</strong>
                  </>
                ) : null}
                {active?.startedAt ? <> — started {when(active.startedAt)}</> : null}. The
                single-run lock is held.
              </div>
            )}
            <div className="toolbar">
              <button
                type="button"
                className="btn btn-primary btn-run"
                onClick={startRun}
                disabled={runDisabledReason !== null}
              >
                {starting ? "Starting…" : "Run"}
              </button>
              {runDisabledReason && <span className="small muted">{runDisabledReason}</span>}
            </div>
            {runError && <ErrorNote message={runError} />}
          </Section>

          {watchName && (
            <Section title="Progress" desc="Derived from disk — survives a tab close or restart.">
              {streaming && (
                <p className="small muted">
                  <span className="spinner" /> Streaming live…
                </p>
              )}

              <div className="bar-label">
                <span>Generation</span>
                <span>
                  {count(progress.generation?.done)} / {count(progress.generation?.total)}
                  {progress.generation?.failed ? ` · ${count(progress.generation.failed)} failed` : ""}
                </span>
              </div>
              <div className="bar">
                <span
                  style={{
                    width: `${pct(progress.generation?.done ?? 0, progress.generation?.total ?? 0)}%`,
                  }}
                />
              </div>

              <div className="bar-label" style={{ marginTop: "0.75rem" }}>
                <span>Extraction</span>
                <span>
                  {count(progress.extraction?.done)} / {count(progress.extraction?.total)}
                  {progress.extraction?.failed ? ` · ${count(progress.extraction.failed)} failed` : ""}
                </span>
              </div>
              <div className="bar">
                <span
                  style={{
                    width: `${pct(progress.extraction?.done ?? 0, progress.extraction?.total ?? 0)}%`,
                  }}
                />
              </div>

              {streamError && <div className="warn-note">{streamError}</div>}

              {progress.terminal && (
                <>
                  <hr className="sep" />
                  {progress.terminal.outageProviders.length > 0 ? (
                    <div className="warn-note">
                      Provider outage: {progress.terminal.outageProviders.join(", ")} completed
                      too few cells. Rendering will refuse unless you acknowledge the outage.
                    </div>
                  ) : (
                    <div className="info-note">Run complete — no provider outages.</div>
                  )}

                  {renderState.status === "outage" && (
                    <div className="warn-note">
                      Render refused: outage on{" "}
                      {renderState.providers.length > 0
                        ? renderState.providers.join(", ")
                        : "one or more providers"}
                      . Acknowledge below to render anyway.
                    </div>
                  )}
                  {renderState.status === "error" && (
                    <ErrorNote message={`Render failed: ${renderState.message}`} />
                  )}
                  {renderState.status === "done" && (
                    <div className="info-note">
                      Rendered <span className="mono">{renderState.reportFile}</span>.{" "}
                      <a href={ROUTES.reports}>View it on the Reports page →</a>
                    </div>
                  )}

                  <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={doRender}
                      disabled={renderState.status === "sending"}
                    >
                      {renderState.status === "sending" ? "Rendering…" : "Render report"}
                    </button>
                    {progress.terminal.outageProviders.length > 0 && (
                      <label className="inline">
                        <input
                          type="checkbox"
                          checked={ackOutage}
                          onChange={(e) => setAckOutage(e.target.checked)}
                        />
                        Acknowledge outage and render anyway
                      </label>
                    )}
                  </div>
                </>
              )}
            </Section>
          )}
        </>
      )}
    </>
  );
}
