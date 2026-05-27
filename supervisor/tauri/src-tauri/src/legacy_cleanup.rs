//! Legacy NSSM service cleanup.
//!
//! The historical `RemoCodeSupervisor` Windows service (installed via the
//! retired `npx remo-code-supervisor install` NSSM path — see
//! `supervisor/MIGRATION.md`) must be removed on existing v0.3.x/v0.4.0/v0.4.1
//! installs so the Tauri MSI app can spawn its own sidecar without colliding.
//!
//! This runs once per install version (gated by a marker file under
//! `%APPDATA%/remo-code-supervisor/`). It is idempotent — `sc.exe delete` of a
//! non-existent service is a no-op with a non-zero exit code we ignore.
//!
//! The Tauri MSI installer itself does NOT install or modify any Windows
//! service. This cleanup exists solely to scrub leftovers from the legacy
//! npm-based installer that earlier versions of this product shipped.

use std::path::PathBuf;

const MARKER_FILE: &str = ".legacy-nssm-cleanup-done-v0.4.2";

fn marker_path() -> Option<PathBuf> {
    let appdata = dirs::config_dir()?;
    Some(appdata.join("remo-code-supervisor").join(MARKER_FILE))
}

pub fn run_once() {
    let marker = match marker_path() {
        Some(p) => p,
        None => return,
    };
    if marker.exists() {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        cleanup_windows_service();
        cleanup_scheduled_task();
    }

    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, b"1");
}

#[cfg(target_os = "windows")]
fn cleanup_windows_service() {
    use std::process::Command;
    // Stop first (ignore error if not running / not present).
    let _ = Command::new("sc.exe")
        .args(["stop", "RemoCodeSupervisor"])
        .output();
    // Delete the service definition (ignore error if absent).
    match Command::new("sc.exe")
        .args(["delete", "RemoCodeSupervisor"])
        .output()
    {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            log::info!(
                "[legacy-cleanup] sc.exe delete RemoCodeSupervisor exit={:?} stdout={} stderr={}",
                o.status.code(),
                stdout.trim(),
                stderr.trim()
            );
        }
        Err(e) => {
            log::warn!("[legacy-cleanup] sc.exe spawn failed: {e}");
        }
    }
}

#[cfg(target_os = "windows")]
fn cleanup_scheduled_task() {
    use std::process::Command;
    // Some legacy installs registered a scheduled task instead of an NSSM
    // service. Remove it if present.
    match Command::new("schtasks.exe")
        .args(["/Delete", "/TN", "RemoCodeSupervisor", "/F"])
        .output()
    {
        Ok(o) => {
            log::info!(
                "[legacy-cleanup] schtasks /Delete RemoCodeSupervisor exit={:?}",
                o.status.code()
            );
        }
        Err(e) => {
            log::warn!("[legacy-cleanup] schtasks spawn failed: {e}");
        }
    }
}
