"use client";

/**
 * /clients — config list (via ConfigPicker) + editor for the selected config:
 * client brand, aliases, white-label, competitors. Saves with PUT and surfaces
 * the returned promptSetVersion. "New config" builds a minimal template
 * client-side then PUTs it.
 */
import { useEffect, useState } from "react";
import { API, type PutConfigResponse, type RunConfig } from "../lib/contract";
import { sendJson, useJson, useSelectedConfig } from "../lib/client";
import ConfigPicker from "../components/ConfigPicker";
import { ErrorNote, Field, Loading, Section } from "../components/index";
import { slugify } from "../lib/format";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function template(clientName: string): RunConfig {
  const today = new Date().toISOString().slice(0, 10);
  return {
    client: { name: clientName, aliases: [clientName], domain: "", industry: "" },
    competitors: [],
    promptSet: { version: "v1", prompts: [] },
    models: { anthropic: "claude-sonnet-5" },
    samplesPerPrompt: 3,
    whiteLabel: { agencyName: clientName, accentColor: "#1a56db" },
    dateRange: { from: today, to: today },
  };
}

/** Tag-style add/remove editor for a string list (aliases). */
function AliasEditor({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [entry, setEntry] = useState("");
  const add = () => {
    const v = entry.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setEntry("");
  };
  return (
    <div>
      <div className="tags">
        {values.length === 0 && <span className="small muted">none yet</span>}
        {values.map((v) => (
          <span className="tag" key={v}>
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="toolbar">
        <input
          type="text"
          value={entry}
          placeholder="Add alias…"
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          style={{ maxWidth: "16rem" }}
        />
        <button type="button" className="btn btn-sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

/** A 6-digit hex like #1a56db — the shape the native color input emits/accepts. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * R9: accent color editor — a native `<input type="color">` (which always emits
 * a valid #rrggbb), a hex text field kept in sync with it, and a live swatch.
 * Because the color picker guarantees validity, a wrong color can't be saved
 * silently; and if the founder hand-types an invalid hex the swatch + the
 * field's invalid styling flag it immediately (never a silent bad save).
 */
function AccentColorField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const valid = HEX_RE.test(value);
  return (
    <div className="color-field">
      <input
        type="color"
        aria-label="Accent color picker"
        value={valid ? value : "#000000"}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        className="color-hex mono"
        value={value}
        placeholder="#1a56db"
        aria-label="Accent color hex"
        aria-invalid={!valid}
        onChange={(e) => onChange(e.target.value)}
      />
      <span
        className={valid ? "color-swatch" : "color-swatch invalid"}
        aria-hidden="true"
        style={valid ? { background: value } : undefined}
        title={valid ? value : "invalid hex"}
      />
    </div>
  );
}

/**
 * R9: white-label logo preview so the founder can verify the URL before a report
 * renders. Fails gracefully — a broken/unreachable URL just hides the image (no
 * broken-image icon). Keyed on the URL by the caller so a new URL remounts and
 * clears the previous error state.
 */
function LogoPreview({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <img
      className="logo-preview"
      src={url}
      alt="Logo preview"
      onError={() => setBroken(true)}
    />
  );
}

export default function ClientsPage() {
  const [selected, select] = useSelectedConfig();
  const url = selected ? API.config(selected) : null;
  const { data, error, loading, reload } = useJson<RunConfig>(url);

  const [draft, setDraft] = useState<RunConfig | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<string | null>(null);

  // (Re)initialize the draft whenever a fresh config loads.
  useEffect(() => {
    if (data) {
      setDraft(clone(data));
      setOriginal(JSON.stringify(data));
      setSavedVersion(null);
      setSaveError(null);
    }
  }, [data]);

  const dirty = draft !== null && JSON.stringify(draft) !== original;

  // R9: warn on tab close / navigation while there are unsaved edits. Registered
  // only while `dirty` (the page's single source of truth), and torn down when
  // it clears or the page unmounts — so it never fires on a clean config.
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

  async function createConfig() {
    const name = window.prompt("New config name (filename, e.g. tikit):");
    if (!name) return;
    const slug = slugify(name);
    const tmpl = template(name);
    setSaving(true);
    setSaveError(null);
    const res = await sendJson<PutConfigResponse>(API.config(slug), "PUT", tmpl);
    setSaving(false);
    if (!res.ok) {
      setSaveError(`Could not create "${slug}": ${res.error}`);
      return;
    }
    select(slug);
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
    setOriginal(JSON.stringify(draft));
    reload();
  }

  return (
    <>
      <div className="page-header">
        <h1>Clients</h1>
        <p>Client brand, white-label, and competitor setup — written to config JSON.</p>
      </div>

      <div className="toolbar" style={{ marginBottom: "1rem" }}>
        <ConfigPicker />
        <button type="button" className="btn btn-sm" onClick={createConfig} disabled={saving}>
          + New config
        </button>
      </div>

      {!selected && <div className="empty">Select or create a config to edit it.</div>}

      {selected && loading && <Loading label="Loading config…" />}
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
              {saving ? "Saving…" : "Save config"}
            </button>
            {dirty && <span className="badge badge-dirty">unsaved changes</span>}
            {!dirty && savedVersion && <span className="badge badge-ok">saved</span>}
            {savedVersion && (
              <span className="small muted">
                prompt-set version:{" "}
                <span className="badge badge-version">{savedVersion}</span>
              </span>
            )}
          </div>

          {saveError && <ErrorNote message={`Save failed: ${saveError}`} />}

          <Section title="Client brand">
            <div className="row">
              <Field label="Client name">
                <input
                  type="text"
                  value={draft.client.name}
                  onChange={(e) => patch((d) => (d.client.name = e.target.value))}
                />
              </Field>
              <Field label="Domain" hint="Bare domain, e.g. tikit.com — counts as a mention only in prose.">
                <input
                  type="text"
                  value={draft.client.domain}
                  placeholder="example.com"
                  onChange={(e) => patch((d) => (d.client.domain = e.target.value))}
                />
              </Field>
            </div>
            <Field
              label="Industry"
              hint="Drives category-aware competitor extraction, e.g. 'influencer marketing agency'."
            >
              <input
                type="text"
                value={draft.client.industry ?? ""}
                onChange={(e) => patch((d) => (d.client.industry = e.target.value))}
              />
            </Field>
            <Field label="Aliases" hint="Legal name, product names, common misspellings.">
              <AliasEditor
                values={draft.client.aliases}
                onChange={(next) => patch((d) => (d.client.aliases = next))}
              />
            </Field>
          </Section>

          <Section title="White-label" desc="Branding shown on the rendered report header.">
            <div className="row">
              <Field label="Agency name">
                <input
                  type="text"
                  value={draft.whiteLabel.agencyName}
                  onChange={(e) => patch((d) => (d.whiteLabel.agencyName = e.target.value))}
                />
              </Field>
              <Field label="Accent color" hint="Report header accent — pick, or type a #rrggbb hex.">
                <AccentColorField
                  value={draft.whiteLabel.accentColor}
                  onChange={(next) => patch((d) => (d.whiteLabel.accentColor = next))}
                />
              </Field>
            </div>
            <Field label="Logo URL" hint="Data URI or absolute URL; empty → text-only header.">
              <input
                type="url"
                value={draft.whiteLabel.logoUrl ?? ""}
                placeholder="https://… or data:…"
                onChange={(e) =>
                  patch((d) => {
                    const v = e.target.value;
                    if (v) d.whiteLabel.logoUrl = v;
                    else delete d.whiteLabel.logoUrl;
                  })
                }
              />
              {draft.whiteLabel.logoUrl && (
                <LogoPreview key={draft.whiteLabel.logoUrl} url={draft.whiteLabel.logoUrl} />
              )}
            </Field>
          </Section>

          <Section
            title="Report period"
            desc="ISO date window shown on the rendered report header; the “to” date also files the trend point."
          >
            <div className="row">
              <Field label="From">
                <input
                  type="date"
                  value={draft.dateRange.from}
                  onChange={(e) => patch((d) => (d.dateRange.from = e.target.value))}
                  style={{ maxWidth: "12rem" }}
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  value={draft.dateRange.to}
                  onChange={(e) => patch((d) => (d.dateRange.to = e.target.value))}
                  style={{ maxWidth: "12rem" }}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Competitors"
            desc="Hand-curated brands to track. Add real competitors here, or promote discovered ones on the Curation page."
            right={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  patch((d) =>
                    d.competitors.push({ name: "", aliases: [], domain: "", industry: "" }),
                  )
                }
              >
                + Add competitor
              </button>
            }
          >
            {draft.competitors.length === 0 && (
              <div className="empty">No competitors yet.</div>
            )}
            {draft.competitors.map((comp, i) => (
              <div className="item-card" key={i}>
                <div className="item-head">
                  <strong>{comp.name.trim() || `Competitor ${i + 1}`}</strong>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => patch((d) => d.competitors.splice(i, 1))}
                  >
                    Remove
                  </button>
                </div>
                <div className="row">
                  <Field label="Name">
                    <input
                      type="text"
                      value={comp.name}
                      onChange={(e) =>
                        patch((d) => (d.competitors[i].name = e.target.value))
                      }
                    />
                  </Field>
                  <Field label="Domain">
                    <input
                      type="text"
                      value={comp.domain}
                      placeholder="optional"
                      onChange={(e) =>
                        patch((d) => (d.competitors[i].domain = e.target.value))
                      }
                    />
                  </Field>
                </div>
                <Field label="Aliases">
                  <AliasEditor
                    values={comp.aliases}
                    onChange={(next) => patch((d) => (d.competitors[i].aliases = next))}
                  />
                </Field>
              </div>
            ))}
          </Section>
        </>
      )}
    </>
  );
}
