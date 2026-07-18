"use client";

/**
 * ConfigPicker — the config selector shown on every page. Fetches the config
 * list (GET /api/configs), persists the selection in localStorage (shared via
 * useSelectedConfig), and defaults to the first config once loaded.
 */
import { useEffect } from "react";
import { API, type ConfigSummary } from "../lib/contract";
import { useJson, useSelectedConfig } from "../lib/client";
import { Spinner } from "./index";

export default function ConfigPicker() {
  const { data, error, loading } = useJson<ConfigSummary[]>(API.configs);
  const [selected, select] = useSelectedConfig();

  const configs = data ?? [];

  // Default to the first config, or reset if the stored selection vanished.
  useEffect(() => {
    if (!data) return;
    if (data.length === 0) return;
    const exists = selected && data.some((c) => c.name === selected);
    if (!exists) select(data[0].name);
  }, [data, selected, select]);

  return (
    <div className="config-picker">
      <span className="label">Config</span>
      {loading && <Spinner />}
      {error && <span className="small muted">list unavailable ({error})</span>}
      {!loading && !error && configs.length === 0 && (
        <span className="small muted">
          no configs yet — create one on the Clients page
        </span>
      )}
      {configs.length > 0 && (
        <select
          value={selected ?? ""}
          onChange={(e) => select(e.target.value)}
          aria-label="Select config"
        >
          {configs.map((c) => (
            <option key={c.name} value={c.name}>
              {c.clientName} ({c.name})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
