//! Pre-flight checks: (1) NSSM service collision, (2) loopback mutex probe.
//!
//! The loopback mutex (binding `127.0.0.1:9106`, fallback `127.0.0.1:9197`) is
//! owned by the Bun sidecar — see PLAN-002 T4. Here we *probe* it before
//! spawning: if a connection to 9106 succeeds, another supervisor is already
//! running and we refuse to start a second one.

use anyhow::{anyhow, Result};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const PRIMARY_PORT: u16 = 9106;
const FALLBACK_PORT: u16 = 9197;

/// Image name of the Bun sidecar the tray manages. The tray process is
/// `remo-supervisor-tauri.exe`, so killing by THIS image name can never touch
/// the tray itself.
#[cfg(target_os = "windows")]
const SIDECAR_IMAGE: &str = "remo-code-supervisor.exe";

/// Reap any orphaned Bun sidecar processes before the tray spawns its own
/// managed one.
///
/// The tray is the SOLE owner of the sidecar (`sidecar::spawn_managed`). Any
/// `remo-code-supervisor.exe` alive when a fresh tray boots is therefore an
/// orphan from a prior manual MSI install (auto-update is OFF) or a crash. If
/// left running it (a) makes the hub read the OLD sidecar's version, and (b)
/// double-spawns PTY subscribers → doubled keystrokes. This MUST run BEFORE
/// `preflight()` (so the loopback ports read as free) and BEFORE
/// `sidecar::spawn_managed` (so we never kill our own child).
///
/// Best-effort: failures are logged and swallowed — never abort startup.
#[cfg(target_os = "windows")]
pub fn reap_orphan_sidecars() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // `taskkill /F /IM <image>` force-kills every process with that image name.
    // Safe here: the managed sidecar has not been spawned yet, and the tray
    // itself runs under a different image name.
    match Command::new("taskkill")
        .args(["/F", "/IM", SIDECAR_IMAGE])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => {
            if out.status.success() {
                log::info!("[reap] taskkill reaped orphan {SIDECAR_IMAGE} process(es)");
            } else {
                // Exit code 128 == "no such process" — the normal, clean case.
                log::info!(
                    "[reap] taskkill found no orphan {SIDECAR_IMAGE} to reap (status {:?})",
                    out.status.code()
                );
            }
        }
        Err(e) => log::warn!("[reap] taskkill failed (best-effort, ignoring): {e}"),
    }
}

/// No-op on non-Windows targets (the release target is Windows).
#[cfg(not(target_os = "windows"))]
pub fn reap_orphan_sidecars() {}

pub fn preflight(app: &AppHandle) -> Result<()> {
    // 1) Legacy NSSM service detected -> hard refuse. The tray app replaced
    // the old `npx remo-code-supervisor install` NSSM path. Anyone upgrading
    // from that path needs to remove the legacy service before the tray app
    // can take over (otherwise two supervisors fight over the same config).
    if crate::nssm::is_nssm_service_running() {
        show_blocking_dialog(
            app,
            "The legacy Remo Code Supervisor Windows service is still installed.\n\n\
             It was replaced by this tray app. Stop and remove it before continuing:\n\
             \n\
             1. Open an elevated PowerShell\n\
             2. Run:  Stop-Service RemoCodeSupervisor; sc.exe delete RemoCodeSupervisor\n\
             \n\
             Then relaunch the tray app.",
        );
        return Err(anyhow!("legacy NSSM service RemoCodeSupervisor is running"));
    }

    // 2) Loopback probe. If we can CONNECT to EITHER 9106 or the 9197 fallback,
    // a live sidecar owns the mutex and another supervisor is already running.
    // (Previously this required BOTH ports — a single stale sidecar holding only
    // 9106 slipped through and got double-spawned. We now reap orphan sidecars
    // in setup() BEFORE this runs, so a true orphan is gone by the time we probe
    // and this only fires for a genuinely-live second instance.)
    if probe_in_use(PRIMARY_PORT) || probe_in_use(FALLBACK_PORT) {
        show_blocking_dialog(
            app,
            "Another Remo Code Supervisor instance is already running.\n\n\
             Only one supervisor can run on this machine at a time.",
        );
        return Err(anyhow!(
            "loopback mutex probe: {PRIMARY_PORT} or {FALLBACK_PORT} appears in use"
        ));
    }

    Ok(())
}

fn probe_in_use(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    // If something accepts our connection on loopback, treat as in-use.
    // 200ms timeout is plenty for loopback.
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn show_blocking_dialog(app: &AppHandle, msg: &str) {
    let _ = app
        .dialog()
        .message(msg)
        .title("Remo Code Supervisor")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}
