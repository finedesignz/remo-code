//! Legacy NSSM service collision check.
//!
//! If the historical `RemoCodeSupervisor` Windows service (installed via the
//! now-retired `npx remo-code-supervisor install` NSSM path — see
//! `supervisor/MIGRATION.md`) is still running, the tray app must NOT spawn a
//! second supervisor process. We detect via PowerShell. The dialog in
//! `mutex_probe.rs` walks the user through removing the legacy service.

#[cfg(target_os = "windows")]
pub fn is_nssm_service_running() -> bool {
    use std::process::Command;
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Service -Name RemoCodeSupervisor -ErrorAction SilentlyContinue).Status",
        ])
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.trim().eq_ignore_ascii_case("Running")
        }
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_nssm_service_running() -> bool {
    false
}
