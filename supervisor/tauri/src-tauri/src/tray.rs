//! Tray icon + menu. Phase 06 Wave 2.

use crate::sidecar;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn build(app: &AppHandle) -> Result<(), anyhow::Error> {
    let open_settings = MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let start = MenuItem::with_id(app, "start", "Start supervisor", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop supervisor", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart supervisor", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Status: idle", false, None::<&str>)?;
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
            &sep2,
            &quit,
        ],
    )?;

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
