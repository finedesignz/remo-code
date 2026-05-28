// Phase 08 — General page: live runtime status of the supervisor sidecar.
//
// All state comes from `get_runtime_status` (Rust IPC). We refresh on mount,
// then poll every 5s — the sidecar lifecycle status changes infrequently and
// the read is purely local-file + an in-process mutex, so a slow cadence keeps
// the UI tab quiet.
//
// Design follows the Roots panel: bg-secondary/60 cards, rounded-xl, indigo
// accent for the primary action, no heavy borders.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  getAutoUpdateStatus,
  subscribeAutoUpdateStatus,
  triggerAutoUpdateCheckNow,
  type AutoUpdateStatus,
} from "../lib/autoUpdater";

interface RuntimeStatus {
  hub_url: string;
  api_key_set: boolean;
  api_key_masked: string;
  hostname: string;
  supervisor_id: string;
  config_path: string;
  config_exists: boolean;
  sidecar_status: string; // idle | starting | running | crashed | stopped
  version: string;
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    running: { color: "bg-emerald-400 ring-emerald-500/30", label: "Running" },
    starting: { color: "bg-amber-400 ring-amber-500/30", label: "Starting" },
    crashed: { color: "bg-red-400 ring-red-500/30", label: "Crashed" },
    stopped: { color: "bg-gray-400 ring-gray-500/30", label: "Stopped" },
    idle: { color: "bg-gray-500 ring-gray-500/30", label: "Idle" },
  };
  const v = map[status] ?? map.idle;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block w-2 h-2 rounded-full ring-2 ${v.color}`} />
      <span className="text-sm text-[var(--text-secondary)]">{v.label}</span>
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 items-start">
      <dt className="text-xs uppercase tracking-wide text-[var(--text-muted)] pt-0.5">{label}</dt>
      <dd className="text-sm text-[var(--text-secondary)] break-all">{children}</dd>
    </div>
  );
}

export default function GeneralPage() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const next = await invoke<RuntimeStatus>("get_runtime_status");
      setStatus(next);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const control = useCallback(async (action: "stop" | "restart" | "start") => {
    setBusy(true);
    try {
      await invoke("sidecar_control", { action });
      // Give the lifecycle loop a moment to flip status before re-reading.
      await new Promise((r) => setTimeout(r, 400));
      await refresh();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const isRunning = status?.sidecar_status === "running" || status?.sidecar_status === "starting";
  const isStopped = status?.sidecar_status === "stopped" || status?.sidecar_status === "crashed" || status?.sidecar_status === "idle";

  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">General</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Live status of the Remo Code supervisor sidecar.
        </p>
      </header>

      {err && (
        <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Sidecar</h2>
          <StatusDot status={status?.sidecar_status ?? "idle"} />
        </div>
        <dl>
          <Row label="Hub URL">
            <span className="font-mono">{status?.hub_url ?? "—"}</span>
          </Row>
          <Row label="Auth">
            {status
              ? status.api_key_set
                ? <span className="text-emerald-300">API key configured</span>
                : <span className="text-amber-300">No API key — open Security to set one</span>
              : "—"}
          </Row>
          <Row label="Supervisor ID">
            <span className="font-mono text-xs">{status?.supervisor_id ?? "—"}</span>
          </Row>
          <Row label="Host">
            <span className="font-mono">{status?.hostname ?? "—"}</span>
          </Row>
          <Row label="Version">
            <span className="font-mono">{status?.version ?? "—"}</span>
          </Row>
        </dl>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => control("restart")}
            disabled={busy || !isRunning}
            className="px-3 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40"
          >
            Restart
          </button>
          {isRunning ? (
            <button
              type="button"
              onClick={() => control("stop")}
              disabled={busy}
              className="px-3 py-2 rounded-lg text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => control("start")}
              disabled={busy || !isStopped}
              className="px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-40"
            >
              Start
            </button>
          )}
          <button
            type="button"
            onClick={() => { void refresh(); }}
            disabled={busy}
            className="px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </section>

      <AutoUpdateSection />

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-2">Config</h2>
        <dl>
          <Row label="Path">
            <span className="font-mono text-xs">{status?.config_path ?? "—"}</span>
          </Row>
          <Row label="State">
            {status?.config_exists
              ? <span className="text-emerald-300">Configured</span>
              : <span className="text-amber-300">Not configured — complete first-run setup</span>}
          </Row>
        </dl>
      </section>
    </div>
  );
}

function AutoUpdateSection() {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [watcher, setWatcher] = useState<AutoUpdateStatus>(getAutoUpdateStatus());

  useEffect(() => {
    void (async () => {
      try {
        const v = await invoke<boolean>("get_auto_update");
        setEnabled(v);
      } catch (e) {
        setErr(String(e));
      }
      try {
        setAppVersion(await getVersion());
      } catch {
        /* ignore */
      }
    })();
    return subscribeAutoUpdateStatus(setWatcher);
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = !enabled;
      const saved = await invoke<boolean>("set_auto_update", { enabled: next });
      setEnabled(saved);
      if (saved) {
        // Kick off an immediate check so the user sees a result without waiting 60s.
        void triggerAutoUpdateCheckNow();
      }
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [enabled]);

  const lastChecked = watcher.lastCheckedAt
    ? formatRelative(watcher.lastCheckedAt)
    : "never";

  return (
    <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Auto-update</h2>
          <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">
            Silently install new versions in the background. Restarts the app when installing.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void toggle(); }}
          disabled={busy}
          aria-pressed={enabled}
          className={[
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            enabled
              ? "bg-indigo-600 ring-1 ring-indigo-500/40"
              : "bg-[var(--bg-tertiary)] ring-1 ring-[var(--border-color)]/40",
            busy ? "opacity-60" : "",
          ].join(" ")}
        >
          <span
            className={[
              "inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
              enabled ? "translate-x-5" : "translate-x-0.5",
            ].join(" ")}
          />
        </button>
      </div>
      {err && (
        <div className="text-xs text-red-300 break-all">{err}</div>
      )}
      <div className="text-xs text-[var(--text-muted)] space-y-1">
        <div>Last checked: <span className="text-[var(--text-secondary)]">{lastChecked}</span></div>
        <div>Latest installed: <span className="text-[var(--text-secondary)] font-mono">{appVersion ? `v${appVersion}` : "—"}</span></div>
        {watcher.lastResult === "error" && watcher.lastError && (
          <div className="text-red-300 break-all">Last error: {watcher.lastError}</div>
        )}
      </div>
    </section>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
