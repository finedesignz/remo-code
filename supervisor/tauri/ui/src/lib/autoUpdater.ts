// Auto-update BRIDGE (fix/headless-autoupdate, 2026-07-13).
//
// This module NO LONGER polls or installs anything. It used to own a 15-minute
// `check()` → `downloadAndInstall()` loop started from a React `useEffect` in
// App.tsx — which meant it only ever ran while the Settings WINDOW was open. The
// supervisor is a tray app that normally has NO window open, so on a headless,
// always-on host the watcher never mounted, never ticked, and the app never
// updated (owner's machine: 14h uptime on v0.13.1 with v0.13.2 published).
//
// The watcher now lives in the Rust backend (`src-tauri/src/auto_update.rs`),
// spawned from the Tauri `setup` hook, so it runs with or without a webview.
// This module is a thin read/trigger bridge onto its commands. Keeping exactly
// ONE implementation is also what guarantees the JS and Rust paths can never
// race on `download_and_install`.
//
// Opt-out is unchanged: `auto_update: false` makes the Rust watcher inert and
// the manual `UpdateNotifier` prompt takes over.

import { invoke } from "@tauri-apps/api/core";

const POLL_INTERVAL_MS = 5_000;

export interface AutoUpdateStatus {
  lastCheckedAt: number | null;
  lastResult: "none" | "disabled" | "update-found" | "installed" | "error";
  lastError: string | null;
  lastVersion?: string | null;
}

let status: AutoUpdateStatus = {
  lastCheckedAt: null,
  lastResult: "none",
  lastError: null,
};

type Listener = (s: AutoUpdateStatus) => void;
const listeners = new Set<Listener>();
let pollTimer: number | null = null;

export function getAutoUpdateStatus(): AutoUpdateStatus {
  return { ...status };
}

async function refresh(): Promise<void> {
  try {
    status = await invoke<AutoUpdateStatus>("auto_update_status");
  } catch (e) {
    console.warn("[autoUpdater] failed to read backend status:", e);
    return;
  }
  const snap = getAutoUpdateStatus();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * Subscribe to the BACKEND watcher's status. Polls the Rust side while at least
 * one listener is mounted (the Settings window); stops when the last unsubscribes.
 */
export function subscribeAutoUpdateStatus(fn: Listener): () => void {
  listeners.add(fn);
  fn(getAutoUpdateStatus());
  void refresh();
  if (pollTimer === null) {
    pollTimer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

/** Settings "Check for updates" button — force one backend pass now. */
export async function triggerAutoUpdateCheckNow(): Promise<void> {
  try {
    status = await invoke<AutoUpdateStatus>("auto_update_check_now");
  } catch (e) {
    status = {
      lastCheckedAt: Date.now(),
      lastResult: "error",
      lastError: String(e),
    };
  }
  await refresh();
}
