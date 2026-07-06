//! Tray icon + menu. Phase 06 Wave 2.
//!
//! B6 (2026-05-28): added the observability poller. Ticks every 5s against
//! the sidecar's loopback /sup/status. Updates the tray tooltip with a
//! colored-dot prefix and surfaces the last error as a disabled "Last error"
//! menu line. When the sidecar is unreachable (process down, status server
//! not yet bound), shows a grey dot — never crashes.

use crate::{runtime_cmds, sidecar};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// Handles to the dynamic menu items + tray icon we need to mutate from the
/// poll loop. Wrapped in an Arc<Mutex<>> so the poller can borrow them across
/// ticks without re-walking the menu tree every time.
pub struct DynMenu {
    pub obs_dot: MenuItem<tauri::Wry>,
    pub obs_err: MenuItem<tauri::Wry>,
}

static DYN_MENU: once_cell::sync::OnceCell<Arc<Mutex<DynMenu>>> = once_cell::sync::OnceCell::new();

pub fn build(app: &AppHandle) -> Result<(), anyhow::Error> {
    let open_settings = MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let start = MenuItem::with_id(app, "start", "Start supervisor", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop supervisor", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart supervisor", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Status: idle", false, None::<&str>)?;
    // B6: hub-connection dot + last-error line — both disabled (display-only).
    let obs_dot = MenuItem::with_id(app, "obs_dot", "● Hub: unknown", false, None::<&str>)?;
    let obs_err = MenuItem::with_id(app, "obs_err", "Last error: —", false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open_settings,
            &sep1,
            &start,
            &stop,
            &restart,
            &status,
            &obs_dot,
            &obs_err,
            &sep2,
            &quit,
        ],
    )?;

    // Stash the dynamic items so the poller can update them later.
    let _ = DYN_MENU.set(Arc::new(Mutex::new(DynMenu {
        obs_dot: obs_dot.clone(),
        obs_err: obs_err.clone(),
    })));

    let _tray = TrayIconBuilder::with_id("main")
        .tooltip("Remo Code Supervisor (idle)")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            // Fall back to embedded tray icon if the bundle icon isn't loaded.
            tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
                .expect("tray.png missing")
        }))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_settings" => {
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "start" => sidecar::start(app),
            "stop" => sidecar::stop(app),
            "restart" => sidecar::restart(app),
            "quit" => {
                sidecar::shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// B6: spawn the 5s status poller. Polls `runtime_cmds::get_sidecar_status`
/// (which TCP-connects to 127.0.0.1:9106 and reads /sup/status) and patches
/// the tray tooltip + menu items. Runs on a tokio interval so it shares the
/// existing runtime — no extra thread.
pub fn spawn_status_poller(app: AppHandle) {
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // We're called from `setup()` which is on the main thread; use a
        // local tokio current-thread runtime so we don't need an outer
        // runtime to be installed.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::warn!("[obs] poller tokio runtime build failed: {e}");
                return;
            }
        };
        rt.block_on(async move {
            // First tick: small delay so the Bun sidecar has a chance to
            // bind 9106 before we paint "unreachable".
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            loop {
                tick(&app_clone);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        });
    });
}

/// True only when BOTH versions are non-empty AND differ. Empty/equal → false,
/// so a parse failure, an unreachable sidecar, or a matched pair never triggers
/// a restart.
fn versions_drifted(tray: &str, sidecar: &str) -> bool {
    !tray.is_empty() && !sidecar.is_empty() && tray != sidecar
}

/// One-shot guard so a persistent version mismatch can't cause a restart loop.
static DRIFT_RESTART_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Self-heal: if the live sidecar reports a version that differs from the tray's
/// own build, a stale sidecar survived a manual install. Restart it ONCE so the
/// hub sees the current version and the PTY subscriber set is rebuilt cleanly.
fn maybe_restart_on_version_drift(app: &AppHandle, s: &runtime_cmds::SidecarStatus) {
    // Only act on a reachable sidecar reporting a concrete version.
    if !s.reachable {
        return;
    }
    let sidecar_version = match s.version.as_deref() {
        Some(v) => v,
        None => return,
    };
    let tray_version = env!("CARGO_PKG_VERSION");
    if !versions_drifted(tray_version, sidecar_version) {
        return;
    }
    use std::sync::atomic::Ordering;
    // compare_exchange: fire exactly once across all ticks.
    if DRIFT_RESTART_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        log::warn!(
            "[drift] sidecar version {sidecar_version} != tray {tray_version} — restarting sidecar once to reconcile"
        );
        sidecar::restart(app);
    }
}

fn tick(app: &AppHandle) {
    let s = runtime_cmds::get_sidecar_status();

    // Self-heal a stale sidecar left over from a manual MSI install.
    maybe_restart_on_version_drift(app, &s);
    let dyn_menu = match DYN_MENU.get() {
        Some(m) => m,
        None => return,
    };
    let guard = dyn_menu.lock();

    // Dot + state line.
    let dot_glyph = match s.dot.as_str() {
        "green" => "●",
        "amber" => "◐",
        "red" => "✗",
        _ => "○",
    };
    let hub_label = if !s.reachable {
        "sidecar unreachable".to_string()
    } else if s.hub_connected {
        "connected".to_string()
    } else {
        s.hub_state.clone().unwrap_or_else(|| "disconnected".to_string())
    };
    let dot_text = format!("{}  Hub: {}", dot_glyph, hub_label);
    let _ = guard.obs_dot.set_text(&dot_text);

    // Last-error line.
    let err_text = match s.last_error.as_deref() {
        Some(msg) if !msg.is_empty() => {
            let trimmed: String = msg.chars().take(80).collect();
            format!("Last error: {}", trimmed)
        }
        _ => "Last error: —".to_string(),
    };
    let _ = guard.obs_err.set_text(&err_text);

    // Tooltip on the tray icon itself.
    let tip = format!(
        "Remo Code Supervisor ({}) — runners: {}",
        if s.hub_connected { "online" } else { &hub_label },
        s.runner_count
    );
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tip));
    }
}

#[cfg(test)]
mod tests {
    use super::versions_drifted;

    #[test]
    fn drift_true_when_differing_nonempty() {
        assert!(versions_drifted("0.12.0", "0.11.0"));
    }

    #[test]
    fn drift_false_when_equal() {
        assert!(!versions_drifted("0.12.0", "0.12.0"));
    }

    #[test]
    fn drift_false_when_either_empty() {
        assert!(!versions_drifted("", "0.11.0"));
        assert!(!versions_drifted("0.12.0", ""));
        assert!(!versions_drifted("", ""));
    }
}
