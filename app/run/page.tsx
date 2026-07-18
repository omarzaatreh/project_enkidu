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
  type FailuresResponse,
  type ProgressEvent,
  type Provider,
  type ProviderProgress,
  type PutConfigResponse,
  type RunConfig,
  type RunFailure,
  ROUTES,
  runsFailuresPath,
} from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import { PER_CALL_USD } from "../lib/pricing";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Field, Loading, Section } from "../components/index";
import { RenderButton } from "../components/RenderButton";
import { count, pct, todayLocalISO, usd, when } from "../lib/format";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The exact slice of a config the Run page can edit (models, samples, and the
 * report period). Serialized identically on load and on save so the dirty-check
 * covers every editable field — editing a date marks the draft dirty just like
 * toggling a provider does.
 */
const dirtyKey = (c: RunConfig): string =>
  JSON.stringify({
    models: c.models,
    samples: c.samplesPerPrompt,
    dateRange: c.dateRange,
  });

const PROVIDERS: { key: Provider; label: string; defaultModel: string }[] = [
  { key: "openai", label: "OpenAI", defaultModel: "gpt-5" },
  { key: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-5" },
  { key: "perplexity", label: "Perplexity", defaultModel: "sonar" },
];

interface ProgressState {
  generation?: { done: number; total: number; failed: number };
  extraction?: { done: number; total: number; failed: number };
  /** Latest per-provider generation breakdown (R7); preserved across frames. */
  byProvider?: ProviderProgress[];
  terminal?: { outageProviders: string[] };
}

/** Human label for a provider key, falling back to the raw key. */
const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  perplexity: "Perplexity",
};

/** Elapsed milliseconds as m:ss (never negative). */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
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
      setOriginal(dirtyKey(cfg));
    }
  }, [cfg]);

  const dirty = draft !== null && dirtyKey(draft) !== original;

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

  // Persist an explicit config via PUT. Defaults to the current draft, but the
  // "Set to today" nudge passes its freshly-built `next` so the write does not
  // depend on the async `setDraft` state having flushed.
  async function saveParams(next: RunConfig | null = draft) {
    if (!next || !selected) return;
    setSaving(true);
    setSaveError(null);
    const res = await sendJson<PutConfigResponse>(API.config(selected), "PUT", next);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setOriginal(dirtyKey(next));
    reloadCfg();
    reloadEst();
  }

  // Atomic "Set to today": set dateRange.to AND persist it in one click, so
  // render (which reads the SAVED config from disk) never picks up the stale
  // date. Reuses saveParams against the explicit `next`, not the draft closure.
  async function setToTodayAndSave() {
    if (!draft) return;
    const next = clone(draft);
    next.dateRange.to = today;
    setDraft(next);
    await saveParams(next);
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

  // R7: elapsed-time clock + failure list, reset per run.
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [terminalAtMs, setTerminalAtMs] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [failures, setFailures] = useState<RunFailure[] | null>(null);

  useEffect(() => {
    if (!watchName) return;
    setProgress({});
    setStreamError(null);
    setTerminalAtMs(null);
    setStartedAtMs(null);
    setFailures(null);
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
        setTerminalAtMs(Date.now());
        setProgress((p) => ({ ...p, terminal: { outageProviders: frame.outageProviders } }));
        es.close();
        reloadActive();
      } else if (frame.phase === "generation") {
        setProgress((p) => ({
          ...p,
          generation: { done: frame.done, total: frame.total, failed: frame.failed },
          // Preserve the last known breakdown when a frame omits it (emitter ticks).
          byProvider: frame.byProvider ?? p.byProvider,
        }));
      } else {
        setProgress((p) => ({
          ...p,
          extraction: { done: frame.done, total: frame.total, failed: frame.failed },
          byProvider: frame.byProvider ?? p.byProvider,
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

  // R7: capture the run's start time from the active-run poll (the SSE stream
  // doesn't carry it) so we can show elapsed time. Only while THIS config runs.
  useEffect(() => {
    if (runningThis && active?.startedAt) {
      const ms = Date.parse(active.startedAt);
      if (Number.isFinite(ms)) setStartedAtMs(ms);
    }
  }, [runningThis, active?.startedAt]);

  // R7: tick a 1s clock while the stream is live, for the elapsed readout. Stops
  // (and the elapsed freezes at terminalAtMs) once the terminal frame lands.
  const liveStreaming = !!watchName && !progress.terminal;
  useEffect(() => {
    if (!liveStreaming) return;
    setNowTs(Date.now());
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveStreaming]);

  // R7: on the terminal frame, fetch the stored failure list when any generation
  // failed. Zero failures → skip the request and render nothing.
  useEffect(() => {
    if (!progress.terminal || !watchName) return;
    if ((progress.generation?.failed ?? 0) <= 0) {
      setFailures([]);
      return;
    }
    let cancelled = false;
    fetch(runsFailuresPath(watchName))
      .then((r) => (r.ok ? (r.json() as Promise<FailuresResponse>) : Promise.reject(new Error())))
      .then((d) => {
        if (!cancelled) setFailures(d.failures);
      })
      .catch(() => {
        if (!cancelled) setFailures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [progress.terminal, watchName, progress.generation?.failed]);

  // --- Render ---------------------------------------------------------------
  // The render state machine (trigger + outage handling + notes) now lives in
  // the shared <RenderButton>. The Run page keeps only the R6 date nudge (which
  // depends on setToTodayAndSave/draft) and the R7 "Review answers →" link, and
  // feeds them to RenderButton through its beforeRender/actions slots.
  const preview = draft ? localEstimate(draft) : null;
  const streaming = !!watchName && !progress.terminal;
  // Elapsed since the run's lock was acquired; freezes at the terminal frame.
  const elapsedMs =
    startedAtMs != null ? (terminalAtMs ?? nowTs) - startedAtMs : null;
  // Plain local calendar date to compare against dateRange.to (also local).
  const today = todayLocalISO();

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

          <Section
            title="Report period"
            desc="Shown on the report header and used as the trend point's date. Does not affect the cost estimate."
          >
            <div className="row">
              <Field label="From" hint="Start of the reporting window (report header only).">
                <input
                  type="date"
                  value={draft.dateRange.from}
                  onChange={(e) => patch((d) => (d.dateRange.from = e.target.value))}
                  style={{ maxWidth: "12rem" }}
                />
              </Field>
              <Field
                label="To"
                hint="End of the window — dates the report and files the trend point under this date."
              >
                <input
                  type="date"
                  value={draft.dateRange.to}
                  onChange={(e) => patch((d) => (d.dateRange.to = e.target.value))}
                  style={{ maxWidth: "12rem" }}
                />
              </Field>
            </div>
            {draft.dateRange.from > draft.dateRange.to && (
              <div className="warn-note">
                The “from” date is after the “to” date — the header range will read backwards.
              </div>
            )}
          </Section>

          <div className="toolbar" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => saveParams()}
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
                  {elapsedMs != null && (
                    <>
                      {" · "}
                      <span className="mono">{fmtElapsed(elapsedMs)}</span> elapsed
                    </>
                  )}
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

              {progress.byProvider && progress.byProvider.length > 1 && (
                <div className="provider-bars">
                  {progress.byProvider.map((b) => (
                    <div className="provider-bar" key={b.provider}>
                      <div className="bar-label">
                        <span>{PROVIDER_LABEL[b.provider] ?? b.provider}</span>
                        <span>
                          {count(b.done)} / {count(b.total)}
                          {b.failed ? ` · ${count(b.failed)} failed` : ""}
                        </span>
                      </div>
                      <div className="bar bar-mini">
                        <span style={{ width: `${pct(b.done, b.total)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

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

                  <div className="estimate" style={{ marginBottom: "1rem" }}>
                    <div className="stat">
                      <span className="num">
                        {count(progress.generation?.done)} / {count(progress.generation?.total)}
                      </span>
                      <span className="cap">Cells completed</span>
                    </div>
                    <div className="stat">
                      <span className="num">
                        {count(
                          (progress.generation?.failed ?? 0) + (progress.extraction?.failed ?? 0),
                        )}
                      </span>
                      <span className="cap">Failures</span>
                    </div>
                    <div className="stat">
                      <span className="num">{elapsedMs != null ? fmtElapsed(elapsedMs) : "—"}</span>
                      <span className="cap">Elapsed</span>
                    </div>
                  </div>

                  {failures && failures.length > 0 && (
                    <details className="warn-note failures">
                      <summary>
                        {count(failures.length)} failed{" "}
                        {failures.length === 1 ? "generation" : "generations"} — click to see the
                        provider errors
                      </summary>
                      <ul className="failure-list">
                        {failures.map((f, i) => (
                          <li key={`${f.provider}-${f.promptId}-${f.sampleIndex}-${i}`}>
                            <div className="failure-head">
                              <strong>{PROVIDER_LABEL[f.provider] ?? f.provider}</strong>
                              <span className="mono small">
                                {f.promptId} · sample {f.sampleIndex}
                              </span>
                            </div>
                            <div className="failure-error mono small">
                              {f.error || "(no error message recorded)"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  <RenderButton
                    configName={selected}
                    toolbarStyle={{ marginTop: "0.5rem" }}
                    beforeRender={
                      draft.dateRange.to !== today ? (
                        <div className="warn-note">
                          Report will be dated{" "}
                          <span className="mono">{draft.dateRange.to}</span> and its trend point
                          recorded under that date — because trend points are deduped by (date,
                          version), a stale date silently <strong>replaces</strong> the prior
                          period’s point instead of adding a new one. Update?{" "}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={setToTodayAndSave}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : "Set to today"}
                          </button>
                        </div>
                      ) : null
                    }
                    actions={
                      <a className="btn btn-sm" href={ROUTES.insights}>
                        Review answers →
                      </a>
                    }
                  />
                </>
              )}
            </Section>
          )}
        </>
      )}
    </>
  );
}
