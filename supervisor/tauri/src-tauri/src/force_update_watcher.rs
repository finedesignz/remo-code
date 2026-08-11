//! Marker-file watcher for hub-initiated forced updates (milestone
//! remote-update-trigger — "Update to latest" button in web Settings).
//!
//! WHY THIS EXISTS AS A SEPARATE WATCHER: the SIDECAR (Bun) holds the hub
//! WebSocket (`supervisor/src/hub-client.ts`) but has no updater of its own —
//! the Rust tray is the SINGLE owner of check→download→install→relaunch
//! (`auto_update::run_check`), and the two are separate processes. When the
//! hub sends `supervisor.force_update`, the sidecar writes a marker file
//! (`%LOCALAPPDATA%\remo-code-supervisor\force-update.json`) and acks back to
//! the hub immediately — it does not and cannot run the update itself. This
//! module is the tray's half: it polls that same marker file, and on finding
//! one it hasn't already handled, DELETES it first (so a relaunched
//! post-install sidecar reading the same path can never re-trigger off a
//! marker it already serviced), then calls the existing `run_check`.
//!
//! A force runs even when the periodic `auto_update` pref is off — it's an
//! explicit user action, not the background cadence — but `run_check`'s own
//! `IN_PROGRESS` guard still applies, so a force during an active install is
//! a no-op (logged, not queued).

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

/// Cadence of the marker poll. Lightweight (a single stat+read on most ticks).
const POLL_INTERVAL: Duration = Duration::from_secs(20);

#[derive(Deserialize, Debug, Clone, PartialEq)]
struct ForceUpdateMarker {
    requested_at: String,
    #[serde(default)]
    #[allow(dead_code)] // surfaced only in the log line
    requested_by: Option<String>,
}

/// Mirrors `supervisorStateDir()` in `supervisor/src/runners/session-breadcrumb.ts`
/// (the Bun sidecar side) — same base dir. `dirs::data_local_dir()` resolves to
/// `%LOCALAPPDATA%` on Windows, matching the sidecar's own resolution there.
/// Kept as its own function (rather than reusing `pty_host_port_file` in
/// lib.rs) so the two token/marker files stay independently named.
fn marker_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    base.join("remo-code-supervisor").join("force-update.json")
}

/// Guards against re-running on the exact same `requested_at` twice. The real
/// guard is that `consume_marker_at` deletes the file BEFORE returning
/// `Some(..)` — this in-memory check only covers the pathological case of a
/// caller re-reading a marker whose delete failed.
static LAST_HANDLED: Mutex<Option<String>> = Mutex::new(None);

/// Core, filesystem-testable logic: if a marker exists at `path` and its
/// `requested_at` differs from `last_handled`, delete the file and return the
/// marker (signal: go ahead and run the update). Otherwise returns `None` and
/// leaves nothing new pending. Any parse/read failure is treated as "nothing
/// to do" rather than crashing the watcher loop.
fn consume_marker_at(path: &PathBuf, last_handled: &mut Option<String>) -> Option<ForceUpdateMarker> {
    let contents = fs::read_to_string(path).ok()?;
    let marker: ForceUpdateMarker = serde_json::from_str(&contents).ok()?;

    if last_handled.as_deref() == Some(marker.requested_at.as_str()) {
        // Already handled this exact request. Clean up the stale duplicate so
        // it doesn't sit there forever, but do NOT run the update again.
        let _ = fs::remove_file(path);
        return None;
    }

    // Delete BEFORE the caller is allowed to run the update — this ordering is
    // the actual guard against a relaunched (post-install) sidecar re-reading
    // the same marker and looping the install.
    if fs::remove_file(path).is_err() {
        // Could not consume it (e.g. permissions/race) — skip this tick rather
        // than risk running twice off an un-deletable marker.
        return None;
    }

    *last_handled = Some(marker.requested_at.clone());
    Some(marker)
}

fn poll_once(path: &PathBuf) -> Option<ForceUpdateMarker> {
    let mut guard = LAST_HANDLED.lock().ok()?;
    consume_marker_at(path, &mut guard)
}

/// Start the marker-poll loop. Spawned once from the Tauri `setup` hook,
/// alongside `auto_update::spawn_watcher` — independent cadence, same
/// underlying `run_check`.
pub fn spawn_watcher(app: AppHandle) {
    log::info!(
        "[force_update_watcher] armed (polling every {}s at {:?})",
        POLL_INTERVAL.as_secs(),
        marker_path()
    );
    let path = marker_path();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if let Some(marker) = poll_once(&path) {
                log::info!(
                    "[force_update_watcher] consumed force-update marker (requested_at={}) — running check now",
                    marker.requested_at
                );
                crate::auto_update::run_check(&app).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_marker_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("remo-force-update-test-{name}.json"))
    }

    #[test]
    fn marker_is_deleted_before_being_returned() {
        let path = tmp_marker_path("delete-first");
        let mut f = fs::File::create(&path).unwrap();
        write!(f, r#"{{"requested_at":"2026-08-11T00:00:00Z"}}"#).unwrap();
        drop(f);

        let mut last_handled: Option<String> = None;
        let marker = consume_marker_at(&path, &mut last_handled);

        assert!(marker.is_some(), "expected the marker to be consumed");
        assert!(
            !path.exists(),
            "marker file must be deleted so a relaunched sidecar can't re-trigger off it"
        );
        assert_eq!(last_handled.as_deref(), Some("2026-08-11T00:00:00Z"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn missing_marker_is_a_noop() {
        let path = tmp_marker_path("missing");
        let _ = fs::remove_file(&path);
        let mut last_handled: Option<String> = None;
        assert!(consume_marker_at(&path, &mut last_handled).is_none());
    }

    #[test]
    fn stale_duplicate_marker_is_not_rerun() {
        // Same requested_at already handled — must not trigger a second run.
        let path = tmp_marker_path("duplicate");
        let mut f = fs::File::create(&path).unwrap();
        write!(f, r#"{{"requested_at":"2026-08-11T00:00:00Z"}}"#).unwrap();
        drop(f);

        let mut last_handled: Option<String> = Some("2026-08-11T00:00:00Z".to_string());
        let marker = consume_marker_at(&path, &mut last_handled);

        assert!(
            marker.is_none(),
            "an already-handled requested_at must not re-run the update"
        );
        assert!(!path.exists(), "the stale duplicate must still be cleaned up");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_new_requested_at_after_a_handled_one_still_runs() {
        let path = tmp_marker_path("second-request");
        let mut f = fs::File::create(&path).unwrap();
        write!(f, r#"{{"requested_at":"2026-08-11T01:00:00Z"}}"#).unwrap();
        drop(f);

        let mut last_handled: Option<String> = Some("2026-08-11T00:00:00Z".to_string());
        let marker = consume_marker_at(&path, &mut last_handled);

        assert!(marker.is_some(), "a genuinely new request must still run");
        assert_eq!(last_handled.as_deref(), Some("2026-08-11T01:00:00Z"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn malformed_marker_is_ignored() {
        let path = tmp_marker_path("malformed");
        let mut f = fs::File::create(&path).unwrap();
        write!(f, "not json").unwrap();
        drop(f);

        let mut last_handled: Option<String> = None;
        assert!(consume_marker_at(&path, &mut last_handled).is_none());

        let _ = fs::remove_file(&path);
    }
}
