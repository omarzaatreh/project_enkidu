"use client";

/**
 * /prompts — prompt editor for the selected config. Each prompt has an
 * auto-slugged id, a text body, and a category. On save the server auto-bumps
 * promptSet.version (content hash) and we surface it, with the resume notice.
 */
import { useEffect, useState } from "react";
import { API, type PutConfigResponse, type RunConfig } from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Field, Loading, Section } from "../components/index";
import { slugify } from "../lib/format";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const CATEGORIES = ["recommendation", "comparison", "informational"] as const;

export default function PromptsPage() {
  const [selected] = useSelectedConfig();
  const url = selected ? API.config(selected) : null;
  const { data, error, loading, reload } = useJson<RunConfig>(url);

  const [draft, setDraft] = useState<RunConfig | null>(null);
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setDraft(clone(data));
      setOriginal(JSON.stringify(data.promptSet.prompts));
      setSavedVersion(null);
      setSaveError(null);
    }
  }, [data]);

  const dirty =
    draft !== null && JSON.stringify(draft.promptSet.prompts) !== original;

  function patch(fn: (d: RunConfig) => void) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      return next;
    });
  }

  async function save() {
    if (!draft || !selected) return;
    setSaving(true);
    setSaveError(null);
    const res = await sendJson<PutConfigResponse>(API.config(selected), "PUT", draft);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setSavedVersion(res.data?.promptSetVersion ?? null);
    setOriginal(JSON.stringify(draft.promptSet.prompts));
    reload();
  }

  const prompts = draft?.promptSet.prompts ?? [];

  return (
    <>
      <div className="page-header">
        <h1>Prompts</h1>
        <p>Buying-intent prompts sent to the models. The version auto-bumps on any edit.</p>
      </div>

      <ConfigPicker />

      {!selected && <div className="empty">Select a config to edit its prompts.</div>}

      {selected && loading && <Loading label="Loading prompts…" />}
      {selected && error && (
        <ErrorNote message={`Could not load "${selected}": ${error}`} />
      )}

      {selected && draft && (
        <>
          <div className="toolbar" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : "Save prompts"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                patch((d) =>
                  d.promptSet.prompts.push({ id: "", text: "", category: "recommendation" }),
                )
              }
            >
              + Add prompt
            </button>
            {dirty && <span className="badge badge-dirty">unsaved changes</span>}
            <span className="small muted">
              current version{" "}
              <span className="badge badge-version">{draft.promptSet.version}</span>
            </span>
          </div>

          {saveError && <ErrorNote message={`Save failed: ${saveError}`} />}

          {savedVersion && (
            <div className="info-note">
              Saved. New prompt-set version{" "}
              <span className="badge badge-version">{savedVersion}</span>. Prompt edits
              re-run only the changed prompts (content-hash resume).
            </div>
          )}

          {prompts.length === 0 && (
            <div className="empty">No prompts yet — add one to get started.</div>
          )}

          {prompts.map((p, i) => (
            <Section key={i}>
              <div className="item-head">
                <span className="small mono muted">{p.id || slugify(p.text)}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => patch((d) => d.promptSet.prompts.splice(i, 1))}
                >
                  Remove
                </button>
              </div>
              <Field label="Prompt text" hint="The id is auto-slugged from this text.">
                <textarea
                  value={p.text}
                  rows={2}
                  onChange={(e) =>
                    patch((d) => {
                      const text = e.target.value;
                      d.promptSet.prompts[i].text = text;
                      d.promptSet.prompts[i].id = slugify(text);
                    })
                  }
                />
              </Field>
              <Field label="Category">
                <select
                  value={p.category ?? "recommendation"}
                  onChange={(e) =>
                    patch((d) => (d.promptSet.prompts[i].category = e.target.value))
                  }
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            </Section>
          ))}
        </>
      )}
    </>
  );
}
