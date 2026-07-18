"use client";

/**
 * The ONE shared render state machine (R8). Before R8 this exact slice —
 * `renderState` + `doRender` + the `OutagePanel` 409 branch + the done/error
 * notes + the trigger button — was duplicated verbatim on the Run and Curation
 * pages. It now lives here and is used by Run, Curation, and Reports.
 *
 * Deliberately narrow: it owns ONLY the POST /api/render → done | 409-outage |
 * error flow. Anything page-specific that used to sit next to the button (the
 * Run page's R6 "Set to today" date nudge, its R7 "Review answers →" link, the
 * per-page done-note wording) is passed in via slots/props so the state machine
 * stays single-copy without absorbing dependencies the other pages don't have.
 *
 * The date-nudge seam (per the R7 reviewer): the nudge depends on the Run page's
 * `setToTodayAndSave`/`draft`, which Curation and Reports don't have, so it MUST
 * NOT move in here. It is rendered through the `beforeRender` slot, gated by the
 * same `!== "outage"` rule the inline version had, and the Run page keeps the
 * save logic on its side of the seam.
 */
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { API, ROUTES, type OutageResponse, type RenderResponse } from "../lib/contract";
import { sendJson } from "../lib/client";
import { ErrorNote, OutagePanel } from "./index";

type RenderState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; reportFile: string }
  | { status: "outage"; providers: string[]; completion: OutageResponse["completion"] }
  | { status: "error"; message: string };

/** Default done note — the Run page's original wording, reused as the fallback. */
function defaultRenderDone(reportFile: string): ReactNode {
  return (
    <div className="info-note">
      Rendered <span className="mono">{reportFile}</span>.{" "}
      <a href={ROUTES.reports}>View it on the Reports page →</a>
    </div>
  );
}

export function RenderButton({
  configName,
  label = "Render report",
  errorLabel = "Render failed",
  renderDone = defaultRenderDone,
  beforeRender,
  actions,
  onRendered,
  toolbarStyle,
}: {
  /** Config to render. When null the button is inert (renders nothing). */
  configName: string | null;
  /** Idle-state button label (busy label is always "Rendering…"). */
  label?: string;
  /** Prefix for the error note, e.g. "Re-render failed". */
  errorLabel?: string;
  /** Success note renderer; return null to show nothing. */
  renderDone?: (reportFile: string) => ReactNode;
  /** Slot rendered above the button, hidden during the outage panel (Run's date nudge). */
  beforeRender?: ReactNode;
  /** Extra controls placed next to the button (Run's "Review answers →" link). */
  actions?: ReactNode;
  /** Fired on a successful render with the new report filename (Reports refreshes the list). */
  onRendered?: (reportFile: string) => void;
  /** Optional style for the trigger toolbar (Run keeps its 0.5rem top margin). */
  toolbarStyle?: CSSProperties;
}) {
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });

  async function doRender(acknowledgeOutage = false) {
    if (!configName) return;
    setRenderState({ status: "sending" });
    const res = await sendJson<RenderResponse>(API.render, "POST", {
      configName,
      acknowledgeOutage,
    });
    if (res.ok && res.data) {
      setRenderState({ status: "done", reportFile: res.data.reportFile });
      onRendered?.(res.data.reportFile);
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

  if (!configName) return null;

  return (
    <>
      {renderState.status === "outage" && (
        <OutagePanel
          outageProviders={renderState.providers}
          completion={renderState.completion}
          onRenderAnyway={() => doRender(true)}
          onDismiss={() => setRenderState({ status: "idle" })}
        />
      )}
      {renderState.status === "error" && (
        <ErrorNote message={`${errorLabel}: ${renderState.message}`} />
      )}
      {renderState.status === "done" && renderDone(renderState.reportFile)}

      {renderState.status !== "outage" && beforeRender}

      {renderState.status !== "outage" && (
        <div className="toolbar" style={toolbarStyle}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => doRender()}
            disabled={renderState.status === "sending"}
          >
            {renderState.status === "sending" ? "Rendering…" : label}
          </button>
          {actions}
        </div>
      )}
    </>
  );
}
