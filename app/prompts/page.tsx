"use client";

/**
 * /prompts — prompt editor for the selected config. Each prompt has an
 * auto-slugged id, a text body, and a category. On save the server auto-bumps
 * promptSet.version (content hash) and we surface it, with the resume notice.
 */
import { useEffect, useMemo, useState } from "react";
import {
  API,
  type InsightsResult,
  type MatrixCell,
  type PutConfigResponse,
  type RunConfig,
} from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Field, Loading, Section } from "../components/index";
import { slugify } from "../lib/format";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const CATEGORIES = ["recommendation", "comparison", "informational"] as const;

// R9: stable draft-local uid for React keys. A monotonic counter guarantees each
// prompt row gets a key that is unique and stays put across text edits, adds, and
// removes — unlike the array index (shifts on remove → textareas mis-associate)
// or promptId (re-slugged on every keystroke). Draft-local only; never persisted.
let uidCounter = 0;
const newUid = (): string => `prompt-${++uidCounter}`;

export default function PromptsPage() {
  const [selected] = useSelectedConfig();
  const url = selected ? API.config(selected) : null;
  const { data, error, loading, reload } = useJson<RunConfig>(url);

  // R10: fetch the insights matrix IN PARALLEL with the config (both hooks fire
  // off `selected` independently — no fetch waterfall). Fail soft: on error or
  // while loading, `insights.data` stays null and the chip row renders empty, so
  // the editor never surfaces an insights error.
  const insights = useJson<InsightsResult>(selected ? API.insightsPath(selected) : null);

  // Index matrix cells by EXACT promptText (mirrors cell hashing — the identity
  // everything uses). One prompt maps to one cell per provider present in the
  // data. Editing a prompt's text changes its content hash, so the lookup misses
  // and its chips DETACH, replaced by the "no results yet" state.
  const matrixByText = useMemo(() => {
    const m = new Map<string, MatrixCell[]>();
    for (const cell of insights.data?.matrix ?? []) {
      const list = m.get(cell.promptText);
      if (list) list.push(cell);
      else m.set(cell.promptText, [cell]);
    }
    return m;
  }, [insights.data]);

  // Only consult the matrix once insights actually loaded (never on error). When
  // this is false the chip row renders empty (reserved height → no layout shift).
  const insightsReady = insights.data !== null && insights.error === null;

  const [draft, setDraft] = useState<RunConfig | null>(null);
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<string | null>(null);
  // R9: uids run parallel to draft.promptSet.prompts (index-aligned) and key the
  // Section list. Mutated in lockstep with the prompts array on load/add/remove.
  const [uids, setUids] = useState<string[]>([]);

  useEffect(() => {
    if (data) {
      setDraft(clone(data));
      setUids(data.promptSet.prompts.map(() => newUid()));
      setOriginal(JSON.stringify(data.promptSet.prompts));
      setSavedVersion(null);
      setSaveError(null);
    }
  }, [data]);

  const dirty =
    draft !== null && JSON.stringify(draft.promptSet.prompts) !== original;

  // R9: warn on tab close / navigation while there are unsaved prompt edits.
  // Registered only while `dirty` (the page's existing source of truth) and torn
  // down when it clears or the page unmounts — never fires on a clean prompt set.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function patch(fn: (d: RunConfig) => void) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      return next;
    });
  }

  // R9: add/remove mutate the prompts array AND the parallel uid list together so
  // they stay index-aligned. Removing prompt i drops uid i, so the remaining rows
  // keep their original keys — React preserves each surviving textarea's DOM node
  // instead of shifting text into the wrong one (the index-key bug).
  function addPrompt() {
    patch((d) =>
      d.promptSet.prompts.push({ id: "", text: "", category: "recommendation" }),
    );
    setUids((u) => [...u, newUid()]);
  }

  function removePrompt(i: number) {
    patch((d) => d.promptSet.prompts.splice(i, 1));
    setUids((u) => u.filter((_, idx) => idx !== i));
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
          <div className="toolbar save-bar" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : "Save prompts"}
            </button>
            <button type="button" className="btn btn-sm" onClick={addPrompt}>
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
            <Section key={uids[i] ?? i}>
              <div className="item-head">
                <span className="small mono muted">{p.id || slugify(p.text)}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => removePrompt(i)}
                >
                  Remove
                </button>
              </div>
              <PromptChips
                cells={insightsReady ? (matrixByText.get(p.text) ?? []) : null}
              />
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

/**
 * R10: the per-prompt performance chip row shown in a prompt's Section header.
 * `cells` is that prompt's matrix rows (one per provider), matched by EXACT
 * promptText, or `null` when insights haven't loaded / errored (fail soft).
 *
 * The row is ALWAYS rendered with a reserved min-height so its three states
 * never cause layout shift:
 *   - null       → empty (insights loading or errored — chips simply absent)
 *   - [] (miss)  → "no results yet" (a new prompt, or an edited/unsaved prompt
 *                  whose text no longer hashes to any matrix row — chips detach)
 *   - [cell,…]   → one muted "provider · mentioned x/n" chip per provider, with
 *                  a flaky marker when the client's mention fraction is unstable.
 */
function PromptChips({ cells }: { cells: MatrixCell[] | null }) {
  return (
    <div className="prompt-chip-row" aria-live="polite">
      {cells === null ? null : cells.length === 0 ? (
        <span className="small muted">no results yet — will run as new</span>
      ) : (
        cells.map((c) => (
          <span key={c.provider} className="chip prompt-chip" title="mentions / samples">
            {c.provider} · mentioned {c.client.mentions}/{c.samples}
            {c.flaky && (
              <span className="prompt-chip-flaky" title="Client named in some samples but not others">
                flaky
              </span>
            )}
          </span>
        ))
      )}
    </div>
  );
}
