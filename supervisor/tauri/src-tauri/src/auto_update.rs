//! Headless auto-update watcher (fix/headless-autoupdate, 2026-07-13).
//!
//! WHY THIS IS IN RUST: the periodic update check used to live in the WEBVIEW
//! (`tauri/ui/src/lib/autoUpdater.ts`, started from a React `useEffect` in
//! `App.tsx`). The supervisor is a TRAY app that normally runs with NO WINDOW
//! OPEN — so the webview never mounts, the effect never runs, and `check()` was
//! never called. The whole auto-update feature was dead for exactly the users it
//! was designed for (headless, always-on, owner away). Owner's machine: up ~14h
//! on v0.13.1, v0.13.2 published with a valid `latest.json`, and the host never
//! updated and never even checked.
//!
//! The watcher now runs on the Tauri async runtime, spawned from the `setup`
//! hook, so it ticks regardless of whether any window/webview exists. It is the
//! SINGLE owner of the check→download→install→relaunch flow; the JS side no
//! longer polls (`lib/autoUpdater.ts` is now a thin bridge onto the commands
//! here), so the two can never race on `download_and_install`.
//!
//! Opt-out is unchanged: `auto_update: false` in `supervisor.json` makes this
//! watcher inert, and the manual `UpdateNotifier` prompt remains the path.
//! The defaulting rule is NOT duplicated here — we call
//! `config_cmds::get_auto_update()` so absent/non-bool ⇒ `true` stays in one place.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Delay before the first check, so tray init / sidecar spawn settle first.
const STARTUP_DELAY: Duration = Duration::from_secs(15);
/// Cadence of subsequent checks (same as the retired JS watcher).
const CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateStatus {
    /// Unix epoch millis of the last completed check (None = never checked).
    pub last_checked_at: Option<i64>,
    /// "none" | "disabled" | "update-found" | "installed" | "error"
    pub last_result: String,
    pub last_error: Option<String>,
    pub last_version: Option<String>,
}

impl Default for AutoUpdateStatus {
    fn default() -> Self {
        Self {
            last_checked_at: None,
            last_result: "none".to_string(),
            last_error: None,
            last_version: None,
        }
    }
}

static STATUS: Mutex<Option<AutoUpdateStatus>> = Mutex::new(None);
/// Guards against two overlapping check/install passes (the periodic tick and a
/// user-triggered "Check now" from Settings). Without this, two
/// `download_and_install` calls could race on the same installer file.
static IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn set_status(result: &str, error: Option<String>, version: Option<String>) {
    let next = AutoUpdateStatus {
        last_checked_at: Some(now_ms()),
        last_result: result.to_string(),
        last_error: error,
        last_version: version,
    };
    if let Ok(mut g) = STATUS.lock() {
        *g = Some(next);
    }
}

/// Pure gating logic, split out so it is unit-testable without a running app.
/// A pass runs only when the pref is enabled AND no other pass is mid-flight.
pub fn should_run_check(auto_update_enabled: bool, in_progress: bool) -> bool {
    auto_update_enabled && !in_progress
}

/// One check→install pass. Logs LOUDLY at every step: the pre-fix silence is why
/// a dead updater went unnoticed for a full day.
pub async fn run_check(app: &AppHandle) {
    let enabled = crate::config_cmds::get_auto_update().unwrap_or(true);
    let in_progress = IN_PROGRESS.load(Ordering::SeqCst);

    if !should_run_check(enabled, in_progress) {
        if !enabled {
            log::info!("[auto_update] skipped: auto_update=false (manual UpdateNotifier owns updates)");
            set_status("disabled", None, None);
        } else {
            log::info!("[auto_update] skipped: a check/install pass is already in flight");
        }
        return;
    }
    // Claim the slot only once we've decided to actually run.
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        log::info!("[auto_update] skipped: lost the race for the in-flight slot");
        return;
    }

    log::info!("[auto_update] checking for updates…");
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::error!("[auto_update] updater unavailable: {e}");
            set_status("error", Some(e.to_string()), None);
            IN_PROGRESS.store(false, Ordering::SeqCst);
            return;
        }
    };

    match updater.check().await {
        Ok(None) => {
            log::info!("[auto_update] up to date");
            set_status("none", None, None);
            IN_PROGRESS.store(false, Ordering::SeqCst);
        }
        Err(e) => {
            log::error!("[auto_update] check failed: {e}");
            set_status("error", Some(e.to_string()), None);
            IN_PROGRESS.store(false, Ordering::SeqCst);
        }
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("[auto_update] update available: v{version} — downloading");
            set_status("update-found", None, Some(version.clone()));
            let res = update
                .download_and_install(
                    |_chunk, _total| {},
                    || log::info!("[auto_update] download finished — installing v{}", version),
                )
                .await;
            match res {
                Ok(()) => {
                    log::info!("[auto_update] installed v{version} — relaunching");
                    set_status("installed", None, Some(version));
                    // NOTE: `restart()` never returns, so IN_PROGRESS is not reset
                    // here on purpose — the process is replaced.
                    app.restart();
                }
                Err(e) => {
                    log::error!("[auto_update] install of v{version} failed: {e}");
                    set_status("error", Some(e.to_string()), Some(version));
                    IN_PROGRESS.store(false, Ordering::SeqCst);
                }
            }
        }
    }
}

/// Start the headless watcher: first check after `STARTUP_DELAY`, then every
/// `CHECK_INTERVAL`. The `auto_update` pref is re-read on EVERY tick, so a
/// mid-session toggle in Settings takes effect on the next one.
pub fn spawn_watcher(app: AppHandle) {
    log::info!(
        "[auto_update] headless watcher armed (first check in {}s, then every {}s)",
        STARTUP_DELAY.as_secs(),
        CHECK_INTERVAL.as_secs()
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            run_check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Settings "Check for updates" button — force one pass now.
#[tauri::command]
pub async fn auto_update_check_now(app: AppHandle) -> Result<AutoUpdateStatus, String> {
    run_check(&app).await;
    Ok(auto_update_status())
}

/// Last known watcher state (drives the Settings status line).
#[tauri::command]
pub fn auto_update_status() -> AutoUpdateStatus {
    STATUS
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_runs_only_when_enabled_and_idle() {
        assert!(should_run_check(true, false));
    }

    #[test]
    fn gate_blocks_when_pref_disabled() {
        // auto_update:false ⇒ the Rust watcher is inert; the manual
        // UpdateNotifier prompt remains the path.
        assert!(!should_run_check(false, false));
        assert!(!should_run_check(false, true));
    }

    #[test]
    fn gate_blocks_a_concurrent_pass() {
        // No double download_and_install, ever.
        assert!(!should_run_check(true, true));
    }

    #[test]
    fn cadence_matches_the_retired_js_watcher() {
        assert_eq!(STARTUP_DELAY.as_secs(), 15);
        assert_eq!(CHECK_INTERVAL.as_secs(), 15 * 60);
    }

    #[test]
    fn default_status_is_never_checked() {
        let s = AutoUpdateStatus::default();
        assert_eq!(s.last_checked_at, None);
        assert_eq!(s.last_result, "none");
        assert_eq!(s.last_error, None);
    }

    #[test]
    fn status_serializes_camel_case_for_the_ui() {
        let json = serde_json::to_string(&AutoUpdateStatus::default()).unwrap();
        assert!(json.contains("lastCheckedAt"), "got {json}");
        assert!(json.contains("lastResult"), "got {json}");
        assert!(json.contains("lastError"), "got {json}");
    }
}
