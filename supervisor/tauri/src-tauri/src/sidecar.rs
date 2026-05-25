//! Bun supervisor sidecar lifecycle — stub for T2.
//!
//! Full lifecycle (spawn, CREATE_NO_WINDOW, restart-on-crash) lands in T3.

use tauri::{AppHandle, Emitter};

pub fn start(app: &AppHandle) {
    let _ = app.emit("supervisor:log", "[sidecar] start (stub)".to_string());
}
pub fn stop(app: &AppHandle) {
    let _ = app.emit("supervisor:log", "[sidecar] stop (stub)".to_string());
}
pub fn restart(app: &AppHandle) {
    let _ = app.emit("supervisor:log", "[sidecar] restart (stub)".to_string());
}
pub fn shutdown(app: &AppHandle) {
    let _ = app.emit("supervisor:log", "[sidecar] shutdown (stub)".to_string());
}
