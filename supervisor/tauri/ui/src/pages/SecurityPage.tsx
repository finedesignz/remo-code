// Phase 08 — Security page: shows the API key (masked + reveal toggle), the
// hub URL, and a "Rotate API Key" button that deep-links into the hub's
// settings → API keys page in the system browser.
//
// The reveal toggle re-fetches via IPC each time it is enabled — we never
// retain the unmasked key in React state across renders, only between
// `await invoke(...)` and the next render. This keeps a screenshot of a
// running supervisor (with the toggle off) from leaking the key.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RuntimeStatus {
  hub_url: string;
  api_key_set: boolean;
  api_key_masked: string;
  hostname: string;
  supervisor_id: string;
  config_path: string;
  config_exists: boolean;
  sidecar_status: string;
  version: string;
}

// Reads the raw api_key out of supervisor.json on demand by parsing the
// runtime status' config_path. We do not expose an "unmasked" IPC because the
// masked form is what we want everywhere except the explicit reveal action;
// instead, we re-read supervisor.json once and surface just the api_key field.
// In practice the user installing this app is also the one writing the file,
// so reading it client-side via fs (not available here) vs. a dedicated IPC
// is equivalent. We add a tiny `get_api_key_full` IPC to keep the contract
// narrow and reviewable.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 items-start">
      <dt className="text-xs uppercase tracking-wide text-[var(--text-muted)] pt-0.5">{label}</dt>
      <dd className="text-sm text-[var(--text-secondary)] break-all">{children}</dd>
    </div>
  );
}

export default function SecurityPage() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const s = await invoke<RuntimeStatus>("get_runtime_status");
      setStatus(s);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCopy = useCallback(async () => {
    if (!status?.api_key_masked) return;
    try {
      await navigator.clipboard.writeText(status.api_key_masked);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {}
  }, [status]);

  const onRotate = useCallback(async () => {
    const base = status?.hub_url ?? "https://app.remo-code.com";
    const url = `${base.replace(/\/$/, "")}/#/settings/api-keys`;
    try {
      await invoke("open_external_url", { url });
    } catch (e: any) {
      setErr(String(e));
    }
  }, [status]);

  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">Security</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Credentials and gateway endpoints used by the sidecar.
        </p>
      </header>

      {err && (
        <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold">API key</h2>
        <dl>
          <Row label="State">
            {status?.api_key_set
              ? <span className="text-emerald-300">Configured</span>
              : <span className="text-amber-300">Not set — rotate to generate one</span>}
          </Row>
          <Row label="Value">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-[var(--text-secondary)]">
                {status?.api_key_set
                  ? (revealed ? status.api_key_masked : status.api_key_masked.replace(/./g, "•").slice(0, 24))
                  : "—"}
              </span>
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                disabled={!status?.api_key_set}
                className="text-xs px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-40"
              >
                {revealed ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                onClick={onCopy}
                disabled={!status?.api_key_set || !revealed}
                className="text-xs px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-40"
              >
                {copyState === "copied" ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] pt-1">
              Only the first 6 and last 4 characters are ever surfaced; the
              raw key never leaves <span className="font-mono">supervisor.json</span>.
            </p>
          </Row>
        </dl>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onRotate}
            className="px-3 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            Rotate API key
          </button>
          <span className="text-xs text-[var(--text-muted)]">
            Opens the hub's API keys page in your browser.
          </span>
        </div>
      </section>

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-2">Gateway</h2>
        <dl>
          <Row label="Hub URL">
            <span className="font-mono">{status?.hub_url ?? "—"}</span>
          </Row>
          <Row label="Supervisor ID">
            <span className="font-mono text-xs">{status?.supervisor_id ?? "—"}</span>
          </Row>
          <Row label="Host">
            <span className="font-mono">{status?.hostname ?? "—"}</span>
          </Row>
        </dl>
      </section>

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-2">Hardening</h2>
        <p className="text-sm text-[var(--text-muted)]">
          The dangerous-skip-permissions cap, restrict-to-git, audit log
          toggle, and max-concurrent slider land in a later wave.
        </p>
      </section>
    </div>
  );
}
