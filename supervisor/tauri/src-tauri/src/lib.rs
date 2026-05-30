//! Remo Code Supervisor — Tauri 2 shell.
//!
//! T4: NSSM-service collision check + loopback mutex probe.

mod config_cmds;
mod first_run;
mod legacy_cleanup;
mod mutex_probe;
mod nssm;
mod runtime_cmds;
mod sidecar;
mod tray;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("settings") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // One-time scrub of the legacy `RemoCodeSupervisor` NSSM service
            // (or scheduled-task equivalent) left behind by pre-Tauri installs.
            // Idempotent and gated by a per-version marker file.
            legacy_cleanup::run_once();

            // Pre-flight: refuse to spawn if NSSM service is running OR another
            // supervisor instance already holds the loopback mutex on
            // 127.0.0.1:9106 (fallback 9197).
            if let Err(e) = mutex_probe::preflight(&app.handle()) {
                log::error!("preflight failed: {e:#}");
                return Err(e.into());
            }

            tray::build(&app.handle())?;

            // First-run: enable autostart + one-time welcome dialog.
            if let Err(e) = first_run::maybe_enable_autostart(&app.handle()) {
                log::warn!("first_run setup failed: {e:#}");
            }

            // Hide-on-close for the settings window.
            if let Some(win) = app.get_webview_window("settings") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_clone.hide();
                    }
                });
            }

            // Spawn the Bun supervisor as a managed sidecar.
            sidecar::spawn_managed(app.handle().clone());

            // B6: poll the sidecar's loopback /sup/status every 5s and update
            // the tray tooltip + status menu item. Graceful when sidecar is
            // unreachable (grey dot, no crash).
            tray::spawn_status_poller(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_cmds::get_config,
            config_cmds::add_root,
            config_cmds::remove_root,
            config_cmds::rescan_now,
            config_cmds::get_auto_update,
            config_cmds::set_auto_update,
            runtime_cmds::get_runtime_status,
            runtime_cmds::get_inventory,
            runtime_cmds::open_external_url,
            runtime_cmds::sidecar_control,
            runtime_cmds::set_api_key,
            runtime_cmds::set_hub_url,
            runtime_cmds::get_sidecar_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Graceful shutdown: actually await the Bun sidecar's reap before
            // the Tauri process exits. Previously `shutdown(app)` only set a
            // flag and `app.exit(0)` raced the `tokio::select!` in the
            // lifecycle thread — leaving orphan claude.exe processes on
            // Windows. Per supervisor audit 2026-05-28.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // If we're already mid-shutdown (lifecycle thread is done),
                // don't loop — let the runtime exit normally.
                if sidecar::is_shutdown_complete() {
                    return;
                }
                api.prevent_exit();
                let app_for_thread = app_handle.clone();
                let exit_code = code.unwrap_or(0);
                // Move the blocking wait off the runtime thread; signalling
                // exit from within an `ExitRequested` handler that also blocks
                // it is fragile. Spawn an OS thread that waits + then re-emits
                // exit.
                std::thread::spawn(move || {
                    let _ = sidecar::shutdown_blocking(
                        &app_for_thread,
                        std::time::Duration::from_secs(5),
                    );
                    app_for_thread.exit(exit_code);
                });
            }
        });
}
