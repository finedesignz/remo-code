// Connections tab — sidecar status + controls, hub URL (single source),
// root folders with inline repo counts, and a compact update-status line.
//
// All backend calls reuse the existing Tauri commands (get_runtime_status,
// sidecar_control, set_hub_url, get_config, add_root, remove_root, rescan_now,
// get_inventory) — this is a UI reorganization, not a backend change.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { RefreshCw, RotateCw, Square, FolderPlus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  ErrorBanner,
  IconButton,
  SectionTitle,
  StatusPill,
  ClickToEditRow,
} from "../components/ui";
import {
  getAutoUpdateStatus,
  subscribeAutoUpdateStatus,
  triggerAutoUpdateCheckNow,
  type AutoUpdateStatus,
} from "../lib/autoUpdater";
import { formatRelativeAgo, isoTooltip } from "../lib/time";

interface RuntimeStatus {
  hub_url: string;
  sidecar_status: string; // idle | starting | running | crashed | stopped
}

interface RootsConfig {
  roots: string[];
  last_scan_at: string | null;
  config_path: string;
  configured: boolean;
}

interface InventoryRepo {
  local_path: string;
  canonical: boolean;
  git_origin_github: { owner: string; repo: string } | null;
}
interface InventorySnapshot {
  scanned_at: string | null;
  repos: InventoryRepo[];
}

// Mirror of the Rust `set_hub_url` validation: http(s) scheme + non-empty host.
function isValidHubUrl(v: string): boolean {
  const t = v.trim().replace(/\/+$/, "");
  const rest = t.startsWith("https://")
    ? t.slice("https://".length)
    : t.startsWith("http://")
    ? t.slice("http://".length)
    : null;
  if (rest === null) return false;
  const host = rest.split(/[/?#]/)[0];
  return host.length > 0 && !host.includes(" ");
}

function pillFor(status: string): { tone: "emerald" | "amber" | "red" | "gray"; label: string } {
  switch (status) {
    case "running":
      return { tone: "emerald", label: "Running" };
    case "starting":
      return { tone: "amber", label: "Starting" };
    case "crashed":
      return { tone: "red", label: "Crashed" };
    case "stopped":
      return { tone: "red", label: "Stopped" };
    default:
      return { tone: "gray", label: "Offline" };
  }
}

// Count repos under a given root by path prefix (normalize separators).
function countReposUnder(root: string, repos: InventoryRepo[]): number {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(root);
  let n = 0;
  for (const repo of repos) {
    const lp = norm(repo.local_path);
    if (lp === r || lp.startsWith(r + "/")) n += 1;
  }
  return n;
}

export default function ConnectionsPage() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [cfg, setCfg] = useState<RootsConfig | null>(null);
  const [inv, setInv] = useState<InventorySnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const [s, c, i] = await Promise.all([
        invoke<RuntimeStatus>("get_runtime_status"),
        invoke<RootsConfig>("get_config"),
        invoke<InventorySnapshot>("get_inventory").catch(() => null),
      ]);
      setStatus(s);
      setCfg(c);
      if (i) setInv(i);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const control = useCallback(
    async (action: "stop" | "restart" | "start") => {
      setBusy(true);
      try {
        await invoke("sidecar_control", { action });
        await new Promise((r) => setTimeout(r, 400));
        await refresh();
      } catch (e: any) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const saveHub = useCallback(
    async (v: string) => {
      try {
        await invoke("set_hub_url", { hubUrl: v });
        window.setTimeout(() => void refresh(), 600);
      } catch (e: any) {
        setErr(String(e));
        throw e;
      }
    },
    [refresh],
  );

  const onAddRoot = useCallback(async () => {
    setBusy(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select a root folder to scan for repos",
      });
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

  const onRemoveRoot = useCallback(
    async (p: string) => {
      // two-step inline confirm
      if (confirmRemove !== p) {
        setConfirmRemove(p);
        if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => setConfirmRemove(null), 4000);
        return;
      }
      setConfirmRemove(null);
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
    },
    [confirmRemove],
  );

  const onRescan = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("rescan_now");
      await new Promise((r) => setTimeout(r, 600));
      await refresh();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const st = status?.sidecar_status ?? "idle";
  const pill = pillFor(st);
  const isRunning = st === "running" || st === "starting";
  const repos = inv?.repos ?? [];

  return (
    <div className="space-y-5">
      <ErrorBanner message={err} />

      {/* Status header + controls */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <StatusPill tone={pill.tone} label={pill.label} />
          <div className="flex items-center gap-0.5">
            <IconButton
              icon={RotateCw}
              label="Restart sidecar"
              onClick={() => void control("restart")}
              disabled={busy || !isRunning}
            />
            {isRunning ? (
              <IconButton
                icon={Square}
                label="Stop sidecar"
                tone="danger"
                onClick={() => void control("stop")}
                disabled={busy}
              />
            ) : (
              <IconButton
                icon={RotateCw}
                label="Start sidecar"
                onClick={() => void control("start")}
                disabled={busy}
              />
            )}
            <IconButton
              icon={RefreshCw}
              label="Refresh status"
              onClick={() => void refresh()}
              disabled={busy}
            />
          </div>
        </div>
        <dl>
          <ClickToEditRow
            label="Hub URL"
            info="The Remo Code hub this supervisor connects to. Editing it restarts the sidecar."
            value={status?.hub_url ?? ""}
            placeholder="https://app.remo-code.com"
            validate={isValidHubUrl}
            onCommit={saveHub}
          />
        </dl>
      </Card>

      {/* Root folders */}
      <Card className="space-y-3">
        <SectionTitle
          title="Root folders"
          info="Folders the supervisor scans for git repos. Worktrees of the same GitHub repo collapse into one session."
          right={
            <div className="flex items-center gap-1.5">
              <span
                className="text-xs text-[var(--text-muted)]"
                title={isoTooltip(inv?.scanned_at ?? cfg?.last_scan_at)}
              >
                scanned {formatRelativeAgo(inv?.scanned_at ?? cfg?.last_scan_at)}
              </span>
              <IconButton
                icon={RefreshCw}
                label="Re-scan now"
                onClick={() => void onRescan()}
                disabled={busy || !cfg || cfg.roots.length === 0}
                size={14}
              />
            </div>
          }
        />

        {!cfg || cfg.roots.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] py-1">
            No roots yet. Add one to begin scanning.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-color)]/40">
            {cfg.roots.map((r) => {
              const count = countReposUnder(r, repos);
              const confirming = confirmRemove === r;
              return (
                <li key={r} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0">
                    <div
                      className="text-xs font-mono text-[var(--text-secondary)] truncate"
                      title={r}
                    >
                      {r}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)]">
                      {inv ? `${count} repo${count === 1 ? "" : "s"}` : "—"}
                    </div>
                  </div>
                  {confirming ? (
                    <button
                      type="button"
                      onClick={() => void onRemoveRoot(r)}
                      disabled={busy}
                      className="shrink-0 px-2 py-1 rounded-lg text-xs text-red-300 ring-1 ring-red-500/40 hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      Confirm remove?
                    </button>
                  ) : (
                    <IconButton
                      icon={Trash2}
                      label="Remove root"
                      tone="danger"
                      onClick={() => void onRemoveRoot(r)}
                      disabled={busy}
                      size={14}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="pt-1">
          <Button variant="ghost" onClick={onAddRoot} disabled={busy}>
            <span className="inline-flex items-center gap-2">
              <FolderPlus size={15} /> Add root
            </span>
          </Button>
        </div>
      </Card>

      {/* Update status (one compact line) */}
      <UpdateStatusLine />
    </div>
  );
}

function UpdateStatusLine() {
  const [appVersion, setAppVersion] = useState("");
  const [watcher, setWatcher] = useState<AutoUpdateStatus>(getAutoUpdateStatus());
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setAppVersion(await getVersion());
      } catch {
        /* ignore */
      }
    })();
    return subscribeAutoUpdateStatus(setWatcher);
  }, []);

  const onCheck = useCallback(async () => {
    setChecking(true);
    try {
      await triggerAutoUpdateCheckNow();
    } finally {
      setChecking(false);
    }
  }, []);

  const checked = watcher.lastCheckedAt
    ? formatRelativeAgo(watcher.lastCheckedAt)
    : "never";

  return (
    <Card className="!py-3 !px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[var(--text-muted)]">
          <span className="font-mono text-[var(--text-secondary)]">
            {appVersion ? `v${appVersion}` : "—"}
          </span>
          <span className="px-1.5">·</span>
          <span title={isoTooltip(watcher.lastCheckedAt)}>checked {checked}</span>
          {watcher.lastResult === "error" && watcher.lastError && (
            <span className="text-red-300"> · check failed</span>
          )}
        </div>
        <IconButton
          icon={RefreshCw}
          label="Check for updates"
          onClick={() => void onCheck()}
          disabled={checking}
          size={14}
        />
      </div>
    </Card>
  );
}
