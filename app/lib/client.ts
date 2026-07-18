"use client";

/**
 * Hand-rolled client-side data layer for the cockpit (no data-fetching deps).
 * Every hook exposes explicit loading / error / empty states so a page renders
 * sanely even though the API is not live in this worktree.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Shape returned by useJson — always one of loading / error / data. */
export interface JsonState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the fetch (e.g. after a mutation). */
  reload: () => void;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* non-JSON body */
  }
  return `HTTP ${res.status}`;
}

/**
 * GET a JSON resource. Pass `null` for the URL to stay idle (no config
 * selected yet) — the hook reports not-loading with null data.
 */
export function useJson<T>(url: string | null): JsonState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(url !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (url === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as T;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Result of a mutation attempt — surfaces status + parsed error body. */
export interface MutationResult<R> {
  ok: boolean;
  status: number;
  data: R | null;
  /** Parsed error message (from `{ error }`) or a status string. */
  error: string | null;
  /** Full parsed error body — carries e.g. outageProviders on 409. */
  errorBody: unknown;
}

/** POST/PUT JSON and return a structured result (never throws on HTTP error). */
export async function sendJson<R>(
  url: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<MutationResult<R>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const msg =
        parsed && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `HTTP ${res.status}`;
      return { ok: false, status: res.status, data: null, error: msg, errorBody: parsed };
    }
    return { ok: true, status: res.status, data: parsed as R, error: null, errorBody: null };
  } catch (e: unknown) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: e instanceof Error ? e.message : String(e),
      errorBody: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Selected-config: persisted in localStorage, shared across every page and the
// ConfigPicker on it via a same-tab custom event.
// ---------------------------------------------------------------------------

const CONFIG_KEY = "enkidu.selectedConfig";
const CONFIG_EVENT = "enkidu:config-change";

/**
 * The config name selected in the ConfigPicker, persisted across pages.
 * Returns `null` until hydrated on the client (SSR-safe).
 */
export function useSelectedConfig(): [string | null, (name: string) => void] {
  const [name, setName] = useState<string | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    const read = () => setName(localStorage.getItem(CONFIG_KEY));
    read();
    hydrated.current = true;
    window.addEventListener(CONFIG_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(CONFIG_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  const select = useCallback((next: string) => {
    localStorage.setItem(CONFIG_KEY, next);
    setName(next);
    window.dispatchEvent(new Event(CONFIG_EVENT));
  }, []);

  return [name, select];
}
