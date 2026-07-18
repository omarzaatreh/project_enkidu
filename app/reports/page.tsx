"use client";

/**
 * /reports — list rendered reports (newest first) with friendly titles, preview
 * a selected one in an iframe, and open it full-screen in a new tab.
 *
 * R8 IA:
 *  - filenames are parsed into "Client — Mon D, YYYY" titles (raw name demoted);
 *  - when a config is selected in the ConfigPicker, other configs' reports are
 *    hidden by default with a visible "Show all configs" toggle;
 *  - the newest report for the current view is auto-selected so the preview is
 *    never empty on load;
 *  - a stale report gets a real "Re-render now" button (the shared RenderButton),
 *    which refreshes the list on success (clearing the badge) or shows the
 *    OutagePanel on a 409.
 */
import { useEffect, useState } from "react";
import { API, type ReportListEntry } from "../lib/contract";
import { useJson, useSelectedConfig } from "../lib/client";
import { ErrorNote, Loading, Section } from "../components/index";
import { RenderButton } from "../components/RenderButton";
import { count, day, when } from "../lib/format";

/** "Tikit — Jul 18, 2026", falling back to the raw filename when unparsed. */
function friendlyTitle(r: ReportListEntry): string {
  if (!r.configName) return r.file;
  const name = r.configName.charAt(0).toUpperCase() + r.configName.slice(1);
  return r.reportDate ? `${name} — ${day(r.reportDate)}` : name;
}

export default function ReportsPage() {
  const { data, error, loading, reload } = useJson<ReportListEntry[]>(API.reports);
  const reports = data ?? [];
  const [selected] = useSelectedConfig();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // When a config is selected we default to showing only its reports; this
  // toggle reveals every config's reports again.
  const [showAll, setShowAll] = useState(false);

  const filtering = !!selected && !showAll;
  const visible = filtering ? reports.filter((r) => r.configName === selected) : reports;
  const hiddenCount = filtering ? reports.length - visible.length : 0;

  // Auto-select the newest visible report so the preview isn't empty on load.
  // Keep a still-visible manual selection; otherwise fall back to the newest
  // (the list arrives newest-first from the API).
  useEffect(() => {
    setSelectedFile((cur) => {
      if (cur && visible.some((r) => r.file === cur)) return cur;
      return visible[0]?.file ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selected, showAll]);

  return (
    <>
      <div className="page-header">
        <h1>Reports</h1>
        <p>Rendered reports, newest first. Click one to preview it inline.</p>
      </div>

      {loading && <Loading label="Loading reports…" />}
      {error && <ErrorNote message={`Could not load reports: ${error}`} />}

      {!loading && !error && reports.length === 0 && (
        <div className="empty">
          No reports yet. Run the pipeline and render a report to see it here.
        </div>
      )}

      {reports.length > 0 && (
        <Section
          title="Rendered reports"
          right={
            selected ? (
              <label className="inline small muted">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={() => setShowAll((v) => !v)}
                />
                Show all configs
              </label>
            ) : undefined
          }
        >
          {filtering && (
            <p className="small muted" style={{ marginTop: 0 }}>
              Showing <strong>{selected}</strong> only
              {hiddenCount > 0 && (
                <> — {count(hiddenCount)} report{hiddenCount === 1 ? "" : "s"} from other configs hidden</>
              )}
              .
            </p>
          )}

          {visible.length === 0 ? (
            <div className="empty">
              No reports for <strong>{selected}</strong> yet. Toggle “Show all configs” to see
              the rest.
            </div>
          ) : (
            <ul className="report-list">
              {visible.map((r) => (
                <li key={r.file} className={r.file === selectedFile ? "active" : undefined}>
                  <div className="report-row-main">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setSelectedFile(r.file)}
                    >
                      Preview
                    </button>
                    <span className="report-title">
                      <strong>{friendlyTitle(r)}</strong>
                      <span className="mono small muted">{r.file}</span>
                    </span>
                    {r.stale && (
                      <span
                        className="badge badge-dirty"
                        title="The results for this config changed after this report was rendered."
                      >
                        ⚠ may be stale
                      </span>
                    )}
                  </div>
                  <div className="toolbar">
                    <span className="small muted">{when(r.mtime)}</span>
                    <a
                      className="btn btn-sm"
                      href={API.report(r.file)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open full ↗
                    </a>
                  </div>
                  {r.stale && r.configName && (
                    <div className="report-rerender">
                      <RenderButton
                        configName={r.configName}
                        label="Re-render now"
                        errorLabel="Re-render failed"
                        renderDone={() => null}
                        onRendered={reload}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {selectedFile && (
        <Section
          title="Preview"
          right={
            <a
              className="btn btn-sm"
              href={API.report(selectedFile)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open full ↗
            </a>
          }
        >
          <p className="small muted mono">{selectedFile}</p>
          <iframe
            className="report-frame"
            src={API.report(selectedFile)}
            title={`Report preview: ${selectedFile}`}
          />
        </Section>
      )}
    </>
  );
}
