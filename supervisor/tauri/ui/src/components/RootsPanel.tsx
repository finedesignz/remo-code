// Phase 08 §15 — Settings → Roots panel.
//
// Lists configured scan roots, lets the user Add / Remove / Re-scan. Talks to
// the Rust side via Tauri `invoke` (commands in src-tauri/src/config_cmds.rs).
// The on-disk format is owned by `supervisor/src/config.ts` (Bun side); this
// component never invents new keys — it only edits `roots`, `scan`, and
// `last_scan_at`.
//
// Aesthetic per global rule #15 + frontend conventions: bg-secondary/60 cards,
// rounded-xl, indigo accents on primary action, no heavy borders.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface ScanSettings {
  max_depth: number;
  ignore_globs: string[];
  follow_symlinks: boolean;
}
interface RootsConfig {
  roots: string[];
  scan: ScanSettings;
  last_scan_at: string | null;
  config_path: string;
  configured: boolean;
}

function formatRelativeAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function RootsPanel() {
  const [cfg, setCfg] = useState<RootsConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const next = await invoke<RootsConfig>("get_config");
      setCfg(next);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = useCallback(async () => {
    setBusy(true);
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select a scan root" });
      if (!selected || Array.isArray(selected)) return;
      const next = await invoke<RootsConfig>("add_root", { path: selected });
      setCfg(next);
      setErr(null);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onRemove = useCallback(async (p: string) => {
    setBusy(true);
    try {
      const next = await invoke<RootsConfig>("remove_root", { path: p });
      setCfg(next);
      setErr(null);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onRescan = useCallback(async () => {
    setBusy(true);
    try {
      const next = await invoke<RootsConfig>("rescan_now");
      setCfg(next);
      setErr(null);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">Roots</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Folders the supervisor scans for git repos. Worktrees of the same GitHub repo collapse into one session.
        </p>
      </header>

      {err && (
        <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Configured roots</h2>
          <span className="text-xs text-[var(--text-muted)]">
            Last scanned: {formatRelativeAgo(cfg?.last_scan_at ?? null)}
          </span>
        </div>

        {!cfg || cfg.roots.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            No roots yet. Add one to begin scanning.
          </p>
        ) : (
          <ul className="space-y-1">
            {cfg.roots.map((r) => (
              <li
                key={r}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)]/40"
              >
                <span className="text-sm font-mono text-[var(--text-secondary)] truncate" title={r}>
                  {r}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(r)}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className="px-3 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40"
          >
            Add root
          </button>
          <button
            type="button"
            onClick={onRescan}
            disabled={busy || !cfg || cfg.roots.length === 0}
            className="px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-40"
          >
            Re-scan now
          </button>
        </div>
      </section>

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold">Scan settings</h2>
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-[var(--text-muted)]">Max depth</dt>
          <dd className="text-[var(--text-secondary)]">{cfg?.scan.max_depth ?? "—"}</dd>
          <dt className="text-[var(--text-muted)]">Follow symlinks</dt>
          <dd className="text-[var(--text-secondary)]">{cfg?.scan.follow_symlinks ? "yes" : "no"}</dd>
          <dt className="text-[var(--text-muted)]">Ignore globs</dt>
          <dd className="text-[var(--text-secondary)] font-mono text-xs">
            {cfg?.scan.ignore_globs.join(", ") ?? "—"}
          </dd>
        </dl>
        {cfg?.config_path && (
          <p className="text-xs text-[var(--text-muted)] pt-1">
            Config: <span className="font-mono">{cfg.config_path}</span>
          </p>
        )}
      </section>
    </div>
  );
}
