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

    // 2) Loopback probe. If we can CONNECT to 9106, another supervisor owns it.
    if probe_in_use(PRIMARY_PORT) && probe_in_use(FALLBACK_PORT) {
        show_blocking_dialog(
            app,
            "Another Remo Code Supervisor instance is already running.\n\n\
             Only one supervisor can run on this machine at a time.",
        );
        return Err(anyhow!(
            "loopback mutex probe: both {PRIMARY_PORT} and {FALLBACK_PORT} appear in use"
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
