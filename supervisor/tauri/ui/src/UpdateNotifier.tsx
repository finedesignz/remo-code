import { useEffect, useState, useCallback, useRef } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; downloaded: number; total: number | null }
  | { kind: "installing"; update: Update }
  | { kind: "error"; message: string }
  | { kind: "dismissed" };

const STARTUP_DELAY_MS = 4_000;
// Periodic background re-check. The supervisor is a long-lived tray app whose
// settings window stays hidden, so the startup + window-focus checks alone never
// fire for days — a running instance would silently miss new releases. Poll on a
// fixed interval so the tray app self-updates without a restart or opening Settings.
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1_000; // 6h
const FOCUS_THROTTLE_MS = 60_000;

export default function UpdateNotifier() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const lastCheckRef = useRef<number>(0);

  const runCheck = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastCheckRef.current < FOCUS_THROTTLE_MS) return;
    lastCheckRef.current = now;

    // If the user opted into auto-update, the background watcher in
    // lib/autoUpdater.ts owns the install flow — don't surface a manual prompt.
    try {
      const auto = await invoke<boolean>("get_auto_update");
      if (auto) {
        setState({ kind: "idle" });
        return;
      }
    } catch {
      /* fall through — treat as manual mode */
    }

    setState((s) =>
      s.kind === "downloading" || s.kind === "installing" ? s : { kind: "checking" },
    );
    try {
      const update = await check();
      if (update) {
        setState({ kind: "available", update });
      } else {
        setState({ kind: "idle" });
      }
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, []);

  // Startup check (delayed so tray init / sidecar settle first).
  useEffect(() => {
    const t = setTimeout(() => runCheck(true), STARTUP_DELAY_MS);
    return () => clearTimeout(t);
  }, [runCheck]);

  // Re-check whenever the settings window regains focus.
  useEffect(() => {
    const onFocus = () => runCheck(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runCheck]);

  // Periodic background re-check (every PERIODIC_CHECK_MS) so a long-running
  // tray app picks up new releases without a restart or opening Settings.
  useEffect(() => {
    const i = setInterval(() => runCheck(false), PERIODIC_CHECK_MS);
    return () => clearInterval(i);
  }, [runCheck]);

  const install = useCallback(async () => {
    if (state.kind !== "available") return;
    const update = state.update;
    setState({ kind: "downloading", update, downloaded: 0, total: null });
    try {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength ?? null;
          setState({ kind: "downloading", update, downloaded: 0, total });
        } else if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          setState({ kind: "downloading", update, downloaded, total });
        } else if (evt.event === "Finished") {
          setState({ kind: "installing", update });
        }
      });
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, [state]);

  const dismiss = () => setState({ kind: "dismissed" });

  if (state.kind === "idle" || state.kind === "checking" || state.kind === "dismissed") {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl bg-[var(--bg-secondary)]/95 backdrop-blur ring-1 ring-blue-500/30 shadow-lg p-4 text-sm">
      {state.kind === "available" && (
        <>
          <div className="font-semibold text-[var(--text-primary)]">
            Update available
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            Version {state.update.version} is ready to install.
          </div>
          <div className="mt-3 flex gap-2 justify-end">
            <button
              onClick={dismiss}
              className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
            >
              Later
            </button>
            <button
              onClick={install}
              className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white"
            >
              Install
            </button>
          </div>
        </>
      )}

      {state.kind === "downloading" && (
        <>
          <div className="font-semibold text-[var(--text-primary)]">
            Downloading v{state.update.version}
          </div>
          <div className="mt-2 h-1.5 w-full rounded bg-[var(--bg-tertiary)] overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-[width] duration-150"
              style={{
                width:
                  state.total && state.total > 0
                    ? `${Math.min(100, (state.downloaded / state.total) * 100)}%`
                    : "33%",
              }}
            />
          </div>
          <div className="mt-1 text-[10px] text-[var(--text-muted)]">
            {formatBytes(state.downloaded)}
            {state.total ? ` / ${formatBytes(state.total)}` : ""}
          </div>
        </>
      )}

      {state.kind === "installing" && (
        <div className="font-semibold text-[var(--text-primary)]">
          Installing v{state.update.version}… app will relaunch.
        </div>
      )}

      {state.kind === "error" && (
        <>
          <div className="font-semibold text-red-400">Update failed</div>
          <div className="text-xs text-[var(--text-muted)] mt-1 break-all">
            {state.message}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={dismiss}
              className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
