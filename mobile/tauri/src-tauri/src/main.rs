// Prevents an additional console window on Windows in release. Harmless on
// mobile targets where this binary is not the entry point (the mobile entry
// point is the cdylib via `tauri::mobile_entry_point`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    remo_code_mobile_lib::run();
}
