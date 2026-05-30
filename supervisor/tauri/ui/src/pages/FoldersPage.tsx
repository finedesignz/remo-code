// Phase 08 — Repos page: shows the most recent repo inventory the supervisor
// emitted (one row per discovered repo). The actual scan runs in the Bun
// sidecar — this page just renders the cached snapshot at
// `<CONFIG_DIR>/last_inventory.json` via the `get_inventory` IPC.
//
// "Refresh" reuses the existing `rescan_now` command (which nulls
// `last_scan_at` in supervisor.json). The sidecar's fs.watch picks up the
// change, re-emits `supervisor.repo_inventory` to the hub, AND rewrites
// last_inventory.json — so we poll briefly until the file's `scanned_at` ticks
// forward, then stop.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface GithubOrigin { owner: string; repo: string }

interface InventoryRepo {
  local_path: string;
  is_git_repo: boolean;
  is_worktree: boolean;
  worktree_parent_path: string | null;
  git_remote: string | null;
  git_origin_github: GithubOrigin | null;
  canonical: boolean;
}

interface InventorySnapshot {
  scanned_at: string | null;
  repos: InventoryRepo[];
  source_path: string;
  source_exists: boolean;
}

function formatRelativeAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function RepoRow({ r }: { r: InventoryRepo }) {
  const repoName = r.git_origin_github
    ? `${r.git_origin_github.owner}/${r.git_origin_github.repo}`
    : r.local_path.split("/").pop() ?? r.local_path;
  return (
    <li className="px-3 py-2.5 rounded-lg hover:bg-[var(--bg-tertiary)]/40 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
          {repoName}
        </span>
        {r.git_origin_github && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-300 ring-1 ring-blue-500/30">
            github
          </span>
        )}
        {!r.is_git_repo && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30">
            local-only
          </span>
        )}
        {r.is_worktree && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-300 ring-1 ring-gray-500/30">
            worktree
          </span>
        )}
        {r.canonical && r.git_origin_github && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30">
            canonical
          </span>
        )}
      </div>
      <div className="text-xs font-mono text-[var(--text-muted)] truncate" title={r.local_path}>
        {r.local_path}
      </div>
      {r.git_remote && (
        <div className="text-xs font-mono text-[var(--text-muted)] truncate" title={r.git_remote}>
          remote: {r.git_remote}
        </div>
      )}
    </li>
  );
}

export default function FoldersPage() {
  const [snap, setSnap] = useState<InventorySnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const next = await invoke<InventorySnapshot>("get_inventory");
      setSnap(next);
      return next;
    } catch (e: any) {
      setErr(String(e));
      return null;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const before = snap?.scanned_at ?? null;
      // rescan_now nulls supervisor.json::last_scan_at — sidecar fs.watch picks
      // it up and re-emits inventory + rewrites last_inventory.json.
      await invoke("rescan_now");
      // Poll up to ~6s for the file to tick forward.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const next = await refresh();
        if (next && next.scanned_at && next.scanned_at !== before) break;
      }
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refresh, snap]);

  const repos = (snap?.repos ?? []).filter((r) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    if (r.local_path.toLowerCase().includes(q)) return true;
    if (r.git_remote?.toLowerCase().includes(q)) return true;
    if (r.git_origin_github && `${r.git_origin_github.owner}/${r.git_origin_github.repo}`.toLowerCase().includes(q)) return true;
    return false;
  });

  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">Repos</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Repos discovered in your configured roots. Worktrees of the same
          GitHub repo collapse into one canonical entry.
        </p>
      </header>

      {err && (
        <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by path, remote, or owner/repo…"
              className="flex-1 px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:ring-1 focus:ring-blue-500/40"
            />
          </div>
          <span className="text-xs text-[var(--text-muted)] shrink-0">
            Last scanned: {formatRelativeAgo(snap?.scanned_at ?? null)}
          </span>
        </div>

        {!snap || repos.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] py-2">
            {snap?.source_exists === false
              ? "No inventory yet. The sidecar emits the first inventory on connect — open Roots to add a folder."
              : filter
                ? "No repos match your filter."
                : "No repos found in the configured roots."}
          </p>
        ) : (
          <ul className="space-y-0.5 max-h-[480px] overflow-y-auto">
            {repos.map((r) => <RepoRow key={r.local_path} r={r} />)}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-3 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
          >
            {refreshing ? "Scanning…" : "Refresh"}
          </button>
          <span className="text-xs text-[var(--text-muted)]">
            {snap ? `${repos.length} shown / ${snap.repos.length} total` : ""}
          </span>
        </div>
      </section>
    </div>
  );
}
