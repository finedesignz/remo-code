//! Pre-flight checks: (1) NSSM service collision, (2) loopback mutex probe.
//!
//! The loopback mutex (binding `127.0.0.1:9106`, fallback `127.0.0.1:9197`) is
//! owned by the Bun sidecar — see PLAN-002 T4. Here we *probe* it before
//! spawning: if a LIVE supervisor answers on 9106, another one is already running
//! and we refuse to start a second.
//!
//! "Live" means it answers `/sup/status` over HTTP — NOT merely that the TCP
//! connect succeeded. A force-killed sidecar can leave its listening socket
//! orphaned in the kernel (owned by `[System]`, no process); that zombie completes
//! the handshake but never responds, and treating it as a live supervisor bricked
//! the tray until reboot. See `probe_in_use`.

use anyhow::{anyhow, Result};
use std::io::{Read, Write};
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

    // 2) Loopback probe. If a LIVE supervisor answers on EITHER 9106 or the 9197
    // fallback, it owns the mutex and another supervisor is already running.
    // "Live" = answers /sup/status, not merely accepts a TCP connect: a force-killed
    // sidecar leaves a zombie listening socket that completes the handshake forever
    // and would otherwise brick this tray permanently (see `probe_in_use`).
    // Orphan sidecar PROCESSES are reaped in setup() before this runs; the zombie
    // SOCKET has no process to reap, which is why the probe itself must be honest.
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

/// Is a LIVE supervisor holding this port?
///
/// REGRESSION (prod, 2026-07-12, during the 0.12.1 MSI → 0.13.0 NSIS migration):
/// this used to be `TcpStream::connect_timeout(..).is_ok()` — "something accepted
/// my connection, therefore a supervisor is running". That is not the same claim.
///
/// Force-killing the sidecar (a crash, a `taskkill`, or an MSI uninstall — i.e.
/// exactly what an upgrade does) can leave its LISTENING socket orphaned in the
/// kernel: `netstat -b` attributes it to `[System]` with NO owning image, and it
/// still completes the TCP handshake. So the bare connect succeeded, preflight
/// concluded "another supervisor is already running", showed the blocking dialog,
/// and refused to spawn — FOREVER, since `reap_orphan_sidecars()` can only
/// `taskkill` a sidecar *image* and there is no process left to kill. The tray was
/// bricked until a reboot, with the port answering on behalf of a process that no
/// longer existed.
///
/// So: connect, then make the listener PROVE it is a supervisor by answering
/// `/sup/status`. A zombie socket accepts the connection and then says nothing —
/// it never sends an HTTP response — so it reads as free and the tray spawns
/// normally. A genuinely live sidecar answers and is correctly detected.
///
/// Fails OPEN (returns false / "not in use") on anything ambiguous: a foreign
/// service squatting the port, a read timeout, a partial write. The failure we are
/// protecting against — two live supervisors — is loud, self-inflicted, and
/// recoverable; the failure this replaces (a tray that can never start again) is
/// silent and needs a reboot. Prefer the recoverable one.
fn probe_in_use(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
        return false; // nothing listening at all
    };

    // Loopback: generous enough for a busy event loop, short enough that a dead
    // socket cannot stall startup.
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }

    // HTTP/1.0 so the server closes the connection itself and we never block.
    let req = format!("GET /sup/status HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() || stream.flush().is_err() {
        return false;
    }

    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        // A live supervisor's status server answers with an HTTP status line. The
        // zombie socket accepts the connection and then never writes a byte —
        // Ok(0) (EOF) or a read timeout — so it correctly reads as free.
        Ok(n) if n > 0 => buf[..n].starts_with(b"HTTP/"),
        _ => false,
    }
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

#[cfg(test)]
mod tests {
    use super::probe_in_use;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::Duration;

    /// Bind a port and return it, leaving the listener in the caller's hands.
    fn listener_on_free_port() -> (TcpListener, u16) {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    /// THE REGRESSION (prod 2026-07-12, MSI → NSIS migration).
    ///
    /// A force-killed sidecar leaves its LISTENING socket orphaned in the kernel. It
    /// still completes the TCP handshake but never writes a byte. The old probe was a
    /// bare `connect().is_ok()`, so it read that as "a supervisor is running", showed
    /// the blocking dialog and refused to spawn — permanently, because
    /// `reap_orphan_sidecars()` can only kill a sidecar *process* and there is none.
    /// The tray was unrecoverable without a reboot.
    ///
    /// Modelled here by a listener that accepts and then goes silent — which is
    /// exactly what the zombie socket does on the wire.
    #[test]
    fn silent_listener_is_not_a_live_supervisor() {
        let (listener, port) = listener_on_free_port();
        thread::spawn(move || {
            // Accept, then hold the connection open saying nothing at all.
            for stream in listener.incoming().take(1) {
                let _s = stream;
                thread::sleep(Duration::from_secs(2));
            }
        });
        assert!(
            !probe_in_use(port),
            "a socket that accepts but never answers /sup/status must NOT count as a live \
             supervisor — that is the zombie that bricked the tray until reboot"
        );
    }

    /// The guarantee we must NOT lose: a genuinely live supervisor is still detected,
    /// so we never spawn a second instance.
    #[test]
    fn live_status_server_is_detected() {
        let (listener, port) = listener_on_free_port();
        // Hand the accept loop a readiness signal. Without it the probe races the
        // thread getting scheduled, and on a cold/loaded machine the accept can land
        // outside the 500ms read window — a flaky CI failure that says nothing about
        // the logic under test.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            ready_tx.send(()).unwrap();
            for stream in listener.incoming().take(1) {
                let mut s: TcpStream = stream.unwrap();
                let body = br#"{"version":"0.13.0"}"#;
                let _ = s.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = s.write_all(body);
                let _ = s.flush();
            }
        });
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("status-server thread never started");
        assert!(
            probe_in_use(port),
            "a live supervisor answering /sup/status MUST still be detected — otherwise we \
             would happily spawn a second instance"
        );
    }

    /// Nothing listening at all — free.
    #[test]
    fn closed_port_is_free() {
        let (listener, port) = listener_on_free_port();
        drop(listener); // port now closed
        assert!(!probe_in_use(port));
    }
}
