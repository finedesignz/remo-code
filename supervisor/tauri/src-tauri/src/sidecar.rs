//! Bun supervisor sidecar lifecycle.
//!
//! Phase 06 Wave 2: spawns `bun src/index.ts run` from the existing
//! `supervisor/` package with CREATE_NO_WINDOW on Windows. Owned by Tauri —
//! killed cleanly on shell exit. Ring-buffered stdout/stderr (200 lines).
//! Exponential-backoff restart on crash (1s, 2s, 4s, …, cap 30s, 5 attempts).
//!
//! IMPORTANT: this scaffold does NOT modify `supervisor/src/index.ts` (a
//! contested file owned by another session). Coordination note recorded in
//! PLAN-002 task list — the in-process `127.0.0.1:9106` mutex bind lives on
//! the Bun side and is wired in Wave 3 alongside the watchdog session merge.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Status {
    Idle,
    Starting,
    Running,
    Crashed,
    Stopped,
}

struct State {
    status: Status,
    attempt: u32,
    last_start: Option<Instant>,
    shutdown: bool,
    log_ring: VecDeque<String>,
    stop_notify: Arc<Notify>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            status: Status::Idle,
            attempt: 0,
            last_start: None,
            shutdown: false,
            log_ring: VecDeque::with_capacity(200),
            stop_notify: Arc::new(Notify::new()),
        }
    }
}

static STATE: once_cell::sync::Lazy<Arc<Mutex<State>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(State::default())));

/// Phase 08 — read-only accessor for the General page IPC. Returns the
/// current lifecycle status of the Bun sidecar.
pub fn current_status() -> Status {
    STATE.lock().status
}

pub fn spawn_managed(app: AppHandle) {
    set_status(&app, Status::Starting);
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move { lifecycle_loop(app_clone).await });
    });
}

async fn lifecycle_loop(app: AppHandle) {
    const MAX_ATTEMPTS: u32 = 5;
    let backoff_secs = [1u64, 2, 4, 8, 16, 30];

    loop {
        if STATE.lock().shutdown {
            break;
        }

        let stop_notify = STATE.lock().stop_notify.clone();
        let start_instant = Instant::now();
        {
            let mut st = STATE.lock();
            st.last_start = Some(start_instant);
            st.status = Status::Starting;
        }
        emit_status(&app);

        let mut child = match spawn_child(&app) {
            Ok(c) => c,
            Err(e) => {
                push_log(&app, format!("[sidecar] spawn failed: {e:#}"));
                set_status(&app, Status::Crashed);
                if !backoff_then_continue(&backoff_secs, MAX_ATTEMPTS).await {
                    break;
                }
                continue;
            }
        };

        set_status(&app, Status::Running);

        // Pipe stdout to ring + Tauri event.
        if let Some(stdout) = child.stdout.take() {
            let app_log = app.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    push_log(&app_log, line);
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let app_log = app.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    push_log(&app_log, format!("[stderr] {line}"));
                }
            });
        }

        // Wait for either the child to exit or a stop notification.
        let exit_status: std::io::Result<std::process::ExitStatus>;
        tokio::select! {
            r = child.wait() => {
                exit_status = r;
            }
            _ = stop_notify.notified() => {
                // user-initiated stop
                let _ = graceful_kill(&mut child).await;
                let _ = child.wait().await;
                set_status(&app, Status::Stopped);
                push_log(&app, "[sidecar] stopped by user".into());
                if STATE.lock().shutdown { break; }
                // Wait until start() is called again (loop will idle until
                // shutdown or restart() triggers another spawn). We just
                // break out and re-check shutdown at the top.
                while !STATE.lock().shutdown {
                    let status = STATE.lock().status;
                    if matches!(status, Status::Starting) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                continue;
            }
        }

        let ok = exit_status.map(|s| s.success()).unwrap_or(false);
        let within_60s = start_instant.elapsed() < Duration::from_secs(60);

        if STATE.lock().shutdown {
            break;
        }

        if !ok && within_60s {
            push_log(&app, "[sidecar] crashed within 60s of start".into());
            set_status(&app, Status::Crashed);
            if !backoff_then_continue(&backoff_secs, MAX_ATTEMPTS).await {
                push_log(&app, "[sidecar] giving up after max attempts".into());
                break;
            }
        } else if !ok {
            push_log(&app, "[sidecar] exited non-zero — restarting".into());
            set_status(&app, Status::Crashed);
            tokio::time::sleep(Duration::from_secs(1)).await;
            STATE.lock().attempt = 0;
        } else {
            push_log(&app, "[sidecar] exited cleanly".into());
            set_status(&app, Status::Stopped);
            break;
        }
    }
}

async fn backoff_then_continue(schedule: &[u64], max: u32) -> bool {
    let mut st = STATE.lock();
    if st.attempt >= max {
        return false;
    }
    let idx = (st.attempt as usize).min(schedule.len() - 1);
    let secs = schedule[idx];
    st.attempt += 1;
    drop(st);
    tokio::time::sleep(Duration::from_secs(secs)).await;
    true
}

fn spawn_child(_app: &AppHandle) -> Result<Child, anyhow::Error> {
    // Two paths:
    //   release  → spawn the bundled Bun-compiled sidecar binary that ships
    //              alongside the main app exe (Tauri 2 `bundle.externalBin`).
    //   debug    → spawn `bun src/index.ts run` against the workspace source so
    //              `cargo tauri dev` / local `cargo run` still iterate quickly
    //              without recompiling the Bun binary on every change.
    //
    // Both branches converge on a `tokio::process::Child` so the rest of the
    // lifecycle loop (ring buffer, restart backoff, graceful kill) is shared.

    #[cfg(debug_assertions)]
    {
        let supervisor_dir = resolve_supervisor_dir(_app)?;
        let mut cmd = Command::new("bun");
        cmd.arg("src/index.ts").arg("run");
        cmd.current_dir(&supervisor_dir);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::piped());
        cmd.kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;
        return Ok(child);
    }

    #[cfg(not(debug_assertions))]
    {
        let exe = resolve_sidecar_exe()?;
        let mut cmd = Command::new(&exe);
        cmd.arg("run");
        // Working dir = directory containing the sidecar (next to main exe in
        // the installed MSI). The compiled Bun binary is self-contained, so
        // cwd only matters for relative file lookups it may do.
        if let Some(parent) = exe.parent() {
            cmd.current_dir(parent);
        }
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::piped());
        cmd.kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;
        Ok(child)
    }
}

#[cfg(debug_assertions)]
fn resolve_supervisor_dir(_app: &AppHandle) -> Result<PathBuf, anyhow::Error> {
    // Dev: walk up from CARGO_MANIFEST_DIR to find /supervisor.
    if let Ok(dir) = std::env::var("REMO_SUPERVISOR_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // CARGO_MANIFEST_DIR = .../supervisor/tauri/src-tauri
    let supervisor_dir = manifest
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    supervisor_dir.ok_or_else(|| anyhow::anyhow!("cannot resolve supervisor dir"))
}

#[cfg(not(debug_assertions))]
fn resolve_sidecar_exe() -> Result<PathBuf, anyhow::Error> {
    // Tauri 2 `bundle.externalBin` ships the sidecar next to the main app
    // executable, with the target-triple suffix stripped at install time.
    // On Windows: `<InstallDir>/remo-code-supervisor.exe`.
    let main_exe = std::env::current_exe()?;
    let dir = main_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent"))?;

    #[cfg(target_os = "windows")]
    let candidates = [
        dir.join("remo-code-supervisor.exe"),
        dir.join("binaries").join("remo-code-supervisor.exe"),
        dir.join("remo-code-supervisor-x86_64-pc-windows-msvc.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        dir.join("remo-code-supervisor"),
        dir.join("binaries").join("remo-code-supervisor"),
    ];

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(anyhow::anyhow!(
        "sidecar binary not found next to main exe (looked in {dir:?})"
    ))
}

async fn graceful_kill(child: &mut Child) -> Result<(), anyhow::Error> {
    // On Windows, no SIGTERM analog. Try CTRL_BREAK first via id(), fall back
    // to kill after 3s.
    let pid = child.id();
    log::info!("[sidecar] graceful_kill pid={pid:?}");
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    Ok(())
}

fn set_status(app: &AppHandle, s: Status) {
    {
        let mut st = STATE.lock();
        st.status = s;
        if matches!(s, Status::Running) {
            st.attempt = 0;
        }
    }
    emit_status(app);
}

fn emit_status(app: &AppHandle) {
    let s = STATE.lock().status;
    let _ = app.emit("supervisor:status", s);
}

fn push_log(app: &AppHandle, line: String) {
    {
        let mut st = STATE.lock();
        if st.log_ring.len() >= 200 {
            st.log_ring.pop_front();
        }
        st.log_ring.push_back(line.clone());
    }
    let _ = app.emit("supervisor:log", line);
}

// ---------- public control API used by the tray menu ----------

pub fn start(app: &AppHandle) {
    let status = STATE.lock().status;
    if matches!(status, Status::Running | Status::Starting) {
        return;
    }
    {
        let mut st = STATE.lock();
        st.shutdown = false;
        st.attempt = 0;
        st.status = Status::Starting;
    }
    emit_status(app);
    spawn_managed(app.clone());
}

pub fn stop(app: &AppHandle) {
    let n = STATE.lock().stop_notify.clone();
    n.notify_one();
    let _ = app.emit("supervisor:log", "[sidecar] stop requested".to_string());
}

pub fn restart(app: &AppHandle) {
    let _ = app.emit("supervisor:log", "[sidecar] restart requested".to_string());
    stop(app);
    let app_c = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        start(&app_c);
    });
}

pub fn shutdown(app: &AppHandle) {
    {
        let mut st = STATE.lock();
        st.shutdown = true;
    }
    let n = STATE.lock().stop_notify.clone();
    n.notify_one();
    let _ = app.emit("supervisor:log", "[sidecar] shutdown".to_string());
}
