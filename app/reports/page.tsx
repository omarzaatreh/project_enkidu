"use client";

/**
 * /reports — list rendered reports (newest first), preview a selected one in an
 * iframe, and open it full-screen in a new tab.
 */
import { useState } from "react";
import { API, type ReportListEntry } from "../lib/contract";
import { useJson } from "../lib/client";
import { ErrorNote, Loading, Section } from "../components/index";
import { when } from "../lib/format";

export default function ReportsPage() {
  const { data, error, loading } = useJson<ReportListEntry[]>(API.reports);
  const reports = data ?? [];
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

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
        <Section title="Rendered reports">
          <ul className="report-list">
            {reports.map((r) => (
              <li key={r.file} className={r.file === selectedFile ? "active" : undefined}>
                <div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSelectedFile(r.file)}
                  >
                    Preview
                  </button>{" "}
                  <span className="mono small">{r.file}</span>
                  {r.stale && (
                    <>
                      {" "}
                      <span
                        className="badge badge-dirty"
                        title="The results for this config changed after this report was rendered."
                      >
                        ⚠ may be stale — re-render
                      </span>
                    </>
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
              </li>
            ))}
          </ul>
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
