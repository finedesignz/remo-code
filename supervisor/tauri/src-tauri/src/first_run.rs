//! Autostart reconciliation + one-time first-launch notice marker.

use anyhow::Result;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn marker_path() -> Option<PathBuf> {
    let appdata = dirs::config_dir()?;
    Some(appdata.join("remo-code-supervisor").join(".first-run-done"))
}

/// Reconcile the OS autostart registration with the desired state on EVERY boot.
///
/// The registration lives outside our config (an HKCU `Run` entry on Windows) and can be
/// removed behind our back — the per-machine MSI -> per-user NSIS switch strips it on
/// uninstall. The `.first-run-done` marker survives that, so gating `enable()` on the marker
/// leaves the supervisor permanently unregistered: config claims autostart is on, the registry
/// has no entry, and nothing ever retries.
///
/// So the marker gates only the one-time welcome dialog. The registration itself is converged
/// from observed state.
pub fn maybe_enable_autostart(app: &AppHandle) -> Result<()> {
    let mgr = app.autolaunch();

    match mgr.is_enabled() {
        Ok(true) => {}
        Ok(false) => {
            if let Err(e) = mgr.enable() {
                log::warn!("autostart enable failed: {e}");
            } else {
                log::info!("autostart registration was missing — re-enabled");
            }
        }
        Err(e) => log::warn!("autostart state unreadable, leaving as-is: {e}"),
    }

    let marker = match marker_path() {
        Some(p) => p,
        None => return Ok(()),
    };
    if marker.exists() {
        return Ok(());
    }

    // First launch only: one-time welcome dialog.
    //
    // NON-blocking on purpose. `blocking_show()` here blocks Tauri's `setup()`, which is what
    // spawns the sidecar — so an unclicked welcome modal (e.g. one that opened off-screen or
    // behind another window) leaves the supervisor permanently sidecar-less and offline while
    // the tray icon looks perfectly healthy. The notice is informational; it must never gate
    // startup.
    app.dialog()
        .message(
            "Remo Code Supervisor will start with Windows.\n\nYou can change this in Settings.",
        )
        .title("Welcome to Remo Code Supervisor")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});

    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, b"1");
    Ok(())
}
