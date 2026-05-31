// Background auto-update watcher.
//
// Polls Tauri's updater on a 15-minute cadence. Each check re-reads the
// `auto_update` preference so toggling it mid-session takes effect on the
// next tick.
//
// DEFAULT (changed 2026-05-31): silent background install is now OPT-IN. The
// `auto_update` pref defaults to FALSE (get_auto_update in config_cmds.rs), so
// out of the box this watcher is inert and the manual `UpdateNotifier` prompt
// ("Update available [Later] [Install]") is the default path — install only on
// a user click, so they're present for the Windows UAC/SmartScreen elevation
// prompt. Rationale: a silent `downloadAndInstall()` that fired while the owner
// was away hung mid-install on the UAC dialog and corrupted the supervisor.
//
// When the pref is explicitly enabled, this module downloads + installs
// silently and relaunches — no dialog, no confirmation (fully preserved).
// When the pref is OFF (the default) this module is inert; the existing
// UpdateNotifier component surfaces the manual prompt.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

const STARTUP_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15min

export interface AutoUpdateStatus {
  lastCheckedAt: number | null;
  lastResult: "none" | "update-found" | "installed" | "error";
  lastError: string | null;
}

const status: AutoUpdateStatus = {
  lastCheckedAt: null,
  lastResult: "none",
  lastError: null,
};

type Listener = (s: AutoUpdateStatus) => void;
const listeners = new Set<Listener>();

export function getAutoUpdateStatus(): AutoUpdateStatus {
  return { ...status };
}

export function subscribeAutoUpdateStatus(fn: Listener): () => void {
  listeners.add(fn);
  fn(getAutoUpdateStatus());
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  const snap = getAutoUpdateStatus();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* ignore listener errors */
    }
  }
}

async function readAutoUpdatePref(): Promise<boolean> {
  try {
    return await invoke<boolean>("get_auto_update");
  } catch (e) {
    console.warn("[autoUpdater] failed to read auto_update pref:", e);
    return false;
  }
}

async function runCheck(): Promise<void> {
  status.lastCheckedAt = Date.now();
  status.lastError = null;

  const enabled = await readAutoUpdatePref();
  if (!enabled) {
    status.lastResult = "none";
    notify();
    return;
  }

  try {
    const update = await check();
    if (!update) {
      status.lastResult = "none";
      notify();
      return;
    }
    console.log(
      `[autoUpdater] update available: v${update.version} — installing silently`,
    );
    status.lastResult = "update-found";
    notify();
    await update.downloadAndInstall();
    status.lastResult = "installed";
    notify();
    await relaunch();
  } catch (e) {
    const msg = String(e);
    console.warn("[autoUpdater] check/install failed:", msg);
    status.lastResult = "error";
    status.lastError = msg;
    notify();
  }
}

let started = false;
let startTimer: number | null = null;
let intervalTimer: number | null = null;

export function startAutoUpdateWatcher(): () => void {
  if (started) return stopAutoUpdateWatcher;
  started = true;

  startTimer = window.setTimeout(() => {
    void runCheck();
    intervalTimer = window.setInterval(() => {
      void runCheck();
    }, CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  return stopAutoUpdateWatcher;
}

export function stopAutoUpdateWatcher(): void {
  started = false;
  if (startTimer !== null) {
    window.clearTimeout(startTimer);
    startTimer = null;
  }
  if (intervalTimer !== null) {
    window.clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

/** Force an immediate check (used by Settings UI after a toggle change). */
export async function triggerAutoUpdateCheckNow(): Promise<void> {
  await runCheck();
}
