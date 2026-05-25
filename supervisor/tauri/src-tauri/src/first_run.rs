//! First-launch autostart enable + one-time notice marker.

use anyhow::Result;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn marker_path() -> Option<PathBuf> {
    let appdata = dirs::config_dir()?;
    Some(appdata.join("remo-code-supervisor").join(".first-run-done"))
}

pub fn maybe_enable_autostart(app: &AppHandle) -> Result<()> {
    let marker = match marker_path() {
        Some(p) => p,
        None => return Ok(()),
    };
    if marker.exists() {
        return Ok(());
    }

    // Enable autostart.
    let mgr = app.autolaunch();
    if let Err(e) = mgr.enable() {
        log::warn!("autostart enable failed: {e}");
    }

    // Show one-time toast/dialog (modal — fine on first run only).
    let _ = app
        .dialog()
        .message(
            "Remo Code Supervisor will start with Windows.\n\nYou can change this in Settings.",
        )
        .title("Welcome to Remo Code Supervisor")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();

    // Write marker last so a failed enable can be retried.
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, b"1");
    Ok(())
}
