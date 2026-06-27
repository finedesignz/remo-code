//! pty_host.rs — Phase-16 Option C: Rust-hosted interactive `claude` ConPTY.
//!
//! DECISION GATE (Task 0, 16-SPIKE-FINDINGS-rust-conpty.md): the Rust-ConPTY
//! spike PASSED, so the interactive `claude` PTY is hosted HERE, in the Tauri
//! Rust process, via wezterm `portable-pty`. The Bun sidecar carries only the
//! thin `claude-pty-bridge.ts` relay; the Phase-15 Node `pty-host.mjs` detour is
//! DROPPED on Windows.
//!
//! BACKEND-AGNOSTIC (Phase-17, R-PTY-12): the spawn frame carries a `cli` field
//! (`"claude"` | `"codex"`, default `"claude"`). The host spawns the matching
//! INTERACTIVE binary with EMPTY argv and scrubs EVERY provider API key. This is
//! how Codex human sessions ride the same raw-terminal surface as Claude.
//!
//! HARD CONSTRAINTS (interactive-pty-runner-SPEC.md — enforced + canary-checked):
//!   1. EVERY provider API key is REMOVED from the spawned env, for BOTH clients:
//!      ANTHROPIC_API_KEY (claude) and OPENAI_API_KEY (codex). No API-key
//!      fallback. (CommandBuilder::env_remove)
//!   2. Official `claude` / `codex` binary only. This host never reads/stores/
//!      forwards the OAuth token / credentials of either client.
//!   5. Interactive ONLY: argv is an ALLOWLIST OF ONE — empty, except for the
//!      optional operator-blessed --dangerously-skip-permissions permission flag
//!      (set when the spawn frame's `dangerously_skip_permissions` is true; gated
//!      upstream by config `allowDangerousSkipPermissions`). NO -p / --print /
//!      --input-format / --output-format / stream-json / app-server / exec — those
//!      programmatic flags stay forbidden. Raw bytes only — this module does NOT
//!      translate to RunnerEvent / agent-protocol / session-bridge.
//!
//! TRANSPORT (Bun <-> Rust local channel): a loopback TCP server on
//! 127.0.0.1:<ephemeral>. The chosen port is written to a small token file the
//! Bun bridge reads (REMO_PTY_HOST_PORT_FILE / default in LOCALAPPDATA). The wire
//! protocol mirrors the Phase-15 `pty-host.mjs` framing for continuity:
//!   4-byte big-endian length prefix + UTF-8 JSON frame.
//!     bridge -> host : {t:'spawn',cli,cwd,cols,rows} | {t:'input',d} |
//!                       {t:'resize',cols,rows} | {t:'kill'} | {t:'reattach'}
//!     host -> bridge : {t:'spawned',pid} | {t:'data',d} | {t:'scrollback',d} |
//!                       {t:'exit',code} | {t:'error',message}
//!   `d` is base64 raw terminal bytes (opaque; never parsed as structured events).
//!
//! LIFECYCLE / detach-vs-kill (R-PTY-27 / H7): the PTY is owned by THIS process
//! (the Tauri supervisor). A bridge socket DISCONNECT does NOT kill the PTY — the
//! session is parked with its scrollback ring-buffer and a later `reattach`
//! replays it (persistence). A `kill` frame, host shutdown, or the Tauri process
//! exiting KILLS the PTY. Because the host lives in the supervisor process, a
//! crashed supervisor tears down every child PTY automatically (process-ownership
//! dead-man's-switch — no orphan `claude` survives a supervisor crash).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use base64::Engine as _;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

/// Default bounded scrollback ring-buffer cap (bytes) for replay on reattach.
/// ~256 KiB is enough for several screens of a TUI without unbounded growth.
const SCROLLBACK_CAP_BYTES: usize = 256 * 1024;

/// A single hosted interactive-`claude` PTY + its bounded scrollback ring.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// The PTY master writer, taken ONCE at spawn and held for the session's
    /// lifetime. `MasterPty::take_writer()` may only be called once — calling it
    /// per-keystroke (the prior bug) succeeded on the first input then returned
    /// Err forever, so only the first character ever reached the child. Hold the
    /// writer here and reuse it for every `session_input`.
    writer: Box<dyn Write + Send>,
    /// Bounded ring-buffer of recent raw PTY output for reattach replay.
    scrollback: Arc<Mutex<RingBuffer>>,
    child_killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

/// A simple byte ring-buffer with a hard cap — keeps the last N bytes of output.
struct RingBuffer {
    buf: Vec<u8>,
    cap: usize,
}

impl RingBuffer {
    fn new(cap: usize) -> Self {
        Self { buf: Vec::new(), cap }
    }
    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > self.cap {
            let overflow = self.buf.len() - self.cap;
            self.buf.drain(0..overflow);
        }
    }
    fn snapshot(&self) -> Vec<u8> {
        self.buf.clone()
    }
}

/// Process-global registry of hosted PTYs keyed by session id. Owned by the
/// supervisor process so PTY lifetime is tied to it (dead-man's-switch).
static SESSIONS: once_cell::sync::Lazy<Arc<Mutex<HashMap<String, PtySession>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Build the env handed to the spawned interactive client. CONSTRAINT 1 — strip
/// EVERY provider API key (both clients), regardless of which `cli` is spawned.
/// Pure + small so the canary/test can reason about it.
fn build_pty_env(cmd: &mut CommandBuilder) {
    // Inherit the supervisor env, then REMOVE every provider API key. Defense in
    // depth: the bridge never forwards them either.
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("OPENAI_API_KEY");
}

/// Resolve the interactive binary name for a `cli` selector. CONSTRAINT 2/5 —
/// official interactive binary only; an unknown selector falls back to `claude`.
fn resolve_cli_binary(cli: &str) -> &'static str {
    match cli {
        "codex" => "codex",
        _ => "claude",
    }
}

/// Spawn (or, if already present, leave alone) the interactive PTY for
/// `session_id`. Returns the captured scrollback handle so the connection loop
/// can stream + replay. CONSTRAINT 5 — selected interactive binary, EMPTY argv.
fn spawn_session(
    session_id: &str,
    cli: &str,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    dangerously_skip_permissions: bool,
) -> std::io::Result<(Arc<Mutex<RingBuffer>>, Option<u32>)> {
    let mut sessions = SESSIONS.lock();
    if let Some(existing) = sessions.get(session_id) {
        // Already hosted — this is a reattach to a surviving PTY.
        return Ok((existing.scrollback.clone(), existing.pid));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

    // CONSTRAINT 5 — selected interactive binary (`claude`/`codex`). argv is an
    // allowlist-of-one: empty, plus the optional operator-blessed
    // --dangerously-skip-permissions. No programmatic/headless flags. Ever.
    let mut cmd = CommandBuilder::new(resolve_cli_binary(cli));
    if dangerously_skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }
    build_pty_env(&mut cmd); // CONSTRAINT 1
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let pid = child.process_id();
    let child_killer = child.clone_killer();

    let scrollback = Arc::new(Mutex::new(RingBuffer::new(SCROLLBACK_CAP_BYTES)));

    // Reader thread: drain the master, push into the ring, fan out to live
    // subscribers via the per-session broadcast list.
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    // Take the writer ONCE here (it can only be taken once) and hold it on the
    // session so every keystroke reuses the SAME writer. See PtySession.writer.
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let ring_for_reader = scrollback.clone();
    let sid_for_reader = session_id.to_string();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    ring_for_reader.lock().push(chunk);
                    broadcast_data(&sid_for_reader, chunk);
                }
                Err(_) => break,
            }
        }
        // PTY ended — reap the registry entry so no orphan lingers.
        SESSIONS.lock().remove(&sid_for_reader);
        broadcast_exit(&sid_for_reader);
    });

    sessions.insert(
        session_id.to_string(),
        PtySession {
            master: pair.master,
            writer,
            scrollback: scrollback.clone(),
            child_killer,
            pid,
        },
    );
    Ok((scrollback, pid))
}

// ── live subscriber fan-out (so multiple bridge connections see the same PTY) ──
//
// Each subscriber carries a stable u64 id so a connection can REMOVE exactly its
// own subscriber on disconnect (no leak) and REPLACE its own subscriber if it
// re-spawns/reattaches the same session (no double broadcast → no doubled
// keystroke echo). Without per-connection removal, a second live bridge
// connection (reconnect / session re-start) fanned out every PTY byte twice.

type Subscriber = Arc<Mutex<dyn FnMut(&[u8]) + Send>>;
static SUBSCRIBERS: once_cell::sync::Lazy<Arc<Mutex<HashMap<String, Vec<(u64, Subscriber)>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));
static NEXT_SUB_ID: AtomicU64 = AtomicU64::new(1);

/// Register `cb` as a live subscriber for `session_id`; returns its stable id.
fn add_subscriber(session_id: &str, cb: Subscriber) -> u64 {
    let id = NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed);
    SUBSCRIBERS
        .lock()
        .entry(session_id.to_string())
        .or_default()
        .push((id, cb));
    id
}

/// Remove the subscriber `sub_id` from `session_id` (idempotent). Used on bridge
/// disconnect and when a connection replaces its own prior subscriber.
fn remove_subscriber(session_id: &str, sub_id: u64) {
    let mut map = SUBSCRIBERS.lock();
    if let Some(subs) = map.get_mut(session_id) {
        subs.retain(|(id, _)| *id != sub_id);
        if subs.is_empty() {
            map.remove(session_id);
        }
    }
}

fn broadcast_data(session_id: &str, bytes: &[u8]) {
    if let Some(subs) = SUBSCRIBERS.lock().get(session_id) {
        for (_, s) in subs {
            (s.lock())(bytes);
        }
    }
}

fn broadcast_exit(session_id: &str) {
    SUBSCRIBERS.lock().remove(session_id);
}

/// Write raw keystroke bytes into the PTY master.
fn session_input(session_id: &str, bytes: &[u8]) {
    if let Some(s) = SESSIONS.lock().get_mut(session_id) {
        // Reuse the writer taken once at spawn — NOT take_writer() per call.
        let _ = s.writer.write_all(bytes);
        let _ = s.writer.flush();
    }
}

fn session_resize(session_id: &str, cols: u16, rows: u16) {
    if let Some(s) = SESSIONS.lock().get(session_id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

/// KILL the PTY (constraint: session close / idle-reap / shutdown). Idempotent.
pub fn session_kill(session_id: &str) {
    if let Some(mut s) = SESSIONS.lock().remove(session_id) {
        let _ = s.child_killer.kill();
    }
    SUBSCRIBERS.lock().remove(session_id);
}

/// Kill ALL hosted PTYs — called on supervisor/Tauri shutdown so nothing leaks.
pub fn kill_all() {
    let ids: Vec<String> = SESSIONS.lock().keys().cloned().collect();
    for id in ids {
        session_kill(&id);
    }
}

// ── loopback control server ────────────────────────────────────────────────

/// Start the loopback PTY-host server on an ephemeral 127.0.0.1 port and write
/// the chosen port to `port_file` so the Bun bridge can discover it. Spawns a
/// background acceptor thread; returns the bound port.
pub fn spawn_host(port_file: Option<std::path::PathBuf>) -> std::io::Result<u16> {
    use std::net::TcpListener;
    // Bind loopback-only on an OS-assigned ephemeral port (never externally
    // reachable — the channel is host-local by construction).
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    if let Some(pf) = port_file {
        if let Some(parent) = pf.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&pf, port.to_string());
    }
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    thread::spawn(move || handle_connection(s));
                }
                Err(_) => break,
            }
        }
    });
    Ok(port)
}

fn handle_connection(stream: std::net::TcpStream) {
    let _ = stream.set_nodelay(true);
    let writer = Arc::new(Mutex::new(stream.try_clone().expect("clone stream")));
    let mut reader = stream;
    let mut session_id: Option<String> = None;
    // This connection's live subscribers, keyed by session id → sub id. Used to
    // (a) REPLACE this connection's prior subscriber when it re-spawns/reattaches
    // the same session (so one connection never double-broadcasts), and
    // (b) REMOVE every subscriber this connection registered on disconnect.
    let mut conn_subs: HashMap<String, u64> = HashMap::new();

    let mut acc: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        acc.extend_from_slice(&buf[..n]);
        // Drain complete frames.
        loop {
            if acc.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([acc[0], acc[1], acc[2], acc[3]]) as usize;
            if acc.len() < 4 + len {
                break;
            }
            let frame_bytes = acc[4..4 + len].to_vec();
            acc.drain(0..4 + len);
            handle_frame(&frame_bytes, &writer, &mut session_id, &mut conn_subs);
        }
    }
    // Bridge socket DISCONNECTED — DETACH, do NOT kill (R-PTY-27). The PTY + its
    // scrollback survive in SESSIONS for a later reattach. Remove ONLY this
    // connection's subscriber(s) so a stale closed-socket writer no longer fans
    // out (no leak, no double broadcast on the next reconnect).
    for (sid, sub_id) in conn_subs.drain() {
        remove_subscriber(&sid, sub_id);
    }
}

fn handle_frame(
    frame_bytes: &[u8],
    writer: &Arc<Mutex<std::net::TcpStream>>,
    session_id: &mut Option<String>,
    conn_subs: &mut HashMap<String, u64>,
) {
    let v: serde_json::Value = match serde_json::from_slice(frame_bytes) {
        Ok(v) => v,
        Err(_) => return,
    };
    let t = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
    match t {
        "spawn" | "reattach" => {
            let sid = v
                .get("session_id")
                .and_then(|x| x.as_str())
                .unwrap_or("default")
                .to_string();
            let cli = v
                .get("cli")
                .and_then(|x| x.as_str())
                .unwrap_or("claude")
                .to_string();
            let cwd = v.get("cwd").and_then(|x| x.as_str()).map(|s| s.to_string());
            let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
            let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
            // Operator-gated bypass (config allowDangerousSkipPermissions upstream).
            // Honored only on a fresh spawn; spawn_session is idempotent on reattach.
            let skip_perms = v
                .get("dangerously_skip_permissions")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            *session_id = Some(sid.clone());

            match spawn_session(&sid, &cli, cwd, cols, rows, skip_perms) {
                Ok((ring, pid)) => {
                    send_frame(writer, &serde_json::json!({ "t": "spawned", "pid": pid }));
                    // Replay scrollback (reattach) BEFORE wiring live output, so
                    // the client sees prior screen state then resumes live.
                    let snap = ring.lock().snapshot();
                    if !snap.is_empty() {
                        send_frame(
                            writer,
                            &serde_json::json!({ "t": "scrollback", "d": b64().encode(&snap) }),
                        );
                    }
                    // Subscribe THIS connection to live output. If this
                    // connection already had a subscriber for this session (a
                    // repeated spawn/reattach on the same socket), REPLACE it so
                    // one connection never fans out the same byte twice.
                    if let Some(prev) = conn_subs.remove(&sid) {
                        remove_subscriber(&sid, prev);
                    }
                    let w = writer.clone();
                    let sub: Subscriber = Arc::new(Mutex::new(move |bytes: &[u8]| {
                        send_frame(&w, &serde_json::json!({ "t": "data", "d": b64().encode(bytes) }));
                    }));
                    let sub_id = add_subscriber(&sid, sub);
                    conn_subs.insert(sid, sub_id);
                }
                Err(e) => {
                    send_frame(writer, &serde_json::json!({ "t": "error", "message": e.to_string() }));
                }
            }
        }
        "input" => {
            if let (Some(sid), Some(d)) = (session_id.as_ref(), v.get("d").and_then(|x| x.as_str())) {
                if let Ok(bytes) = b64().decode(d) {
                    session_input(sid, &bytes);
                }
            }
        }
        "resize" => {
            if let Some(sid) = session_id.as_ref() {
                let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
                let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
                session_resize(sid, cols, rows);
            }
        }
        "kill" => {
            if let Some(sid) = session_id.as_ref() {
                session_kill(sid);
            }
        }
        _ => {}
    }
}

fn send_frame(writer: &Arc<Mutex<std::net::TcpStream>>, obj: &serde_json::Value) {
    let body = serde_json::to_vec(obj).unwrap_or_default();
    let len = (body.len() as u32).to_be_bytes();
    let mut w = writer.lock();
    let _ = w.write_all(&len);
    let _ = w.write_all(&body);
    let _ = w.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test subscriber that records every byte-chunk it receives into a shared
    /// counter buffer, so we can assert HOW MANY times a given byte was delivered.
    fn counting_sub(sink: Arc<Mutex<Vec<u8>>>) -> Subscriber {
        Arc::new(Mutex::new(move |bytes: &[u8]| {
            sink.lock().extend_from_slice(bytes);
        }))
    }

    /// (a) A single logical connection that subscribes the SAME session twice
    /// (e.g. spawn then reattach on one socket) must end up with exactly ONE
    /// active subscriber, so a broadcast is delivered ONCE — not doubled.
    #[test]
    fn one_connection_replace_yields_single_subscriber_no_double_broadcast() {
        let sid = "test-replace-session";
        SUBSCRIBERS.lock().remove(sid);

        // Simulate handle_connection's per-connection bookkeeping.
        let mut conn_subs: HashMap<String, u64> = HashMap::new();
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));

        // First subscribe (spawn).
        let id1 = add_subscriber(sid, counting_sub(sink.clone()));
        conn_subs.insert(sid.to_string(), id1);

        // Second subscribe on the SAME connection (reattach) — must REPLACE.
        if let Some(prev) = conn_subs.remove(sid) {
            remove_subscriber(sid, prev);
        }
        let id2 = add_subscriber(sid, counting_sub(sink.clone()));
        conn_subs.insert(sid.to_string(), id2);

        // Exactly one active subscriber for the session.
        assert_eq!(SUBSCRIBERS.lock().get(sid).map(|v| v.len()), Some(1));

        // A broadcast reaches the byte ONCE (would be twice with the old bug).
        broadcast_data(sid, b"X");
        assert_eq!(&*sink.lock(), b"X");

        // cleanup
        for (s, id) in conn_subs.drain() {
            remove_subscriber(&s, id);
        }
        assert!(SUBSCRIBERS.lock().get(sid).is_none());
    }

    /// (b) After a connection's cleanup runs (disconnect), its subscriber is
    /// removed and a subsequent broadcast does NOT reach it.
    #[test]
    fn cleanup_removes_subscriber_so_later_broadcast_skips_it() {
        let sid = "test-cleanup-session";
        SUBSCRIBERS.lock().remove(sid);

        let mut conn_subs: HashMap<String, u64> = HashMap::new();
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));

        let id = add_subscriber(sid, counting_sub(sink.clone()));
        conn_subs.insert(sid.to_string(), id);

        // Live before cleanup.
        broadcast_data(sid, b"A");
        assert_eq!(&*sink.lock(), b"A");

        // Disconnect cleanup (mirrors handle_connection's drain loop).
        for (s, sub_id) in conn_subs.drain() {
            remove_subscriber(&s, sub_id);
        }
        assert!(SUBSCRIBERS.lock().get(sid).is_none());

        // Post-cleanup broadcast must NOT reach the removed subscriber.
        broadcast_data(sid, b"B");
        assert_eq!(&*sink.lock(), b"A");
    }

    /// Two DISTINCT live connections on one session each get exactly one
    /// delivery; removing one leaves the other intact (no over-removal).
    #[test]
    fn two_connections_each_deliver_once_independent_removal() {
        let sid = "test-two-conn-session";
        SUBSCRIBERS.lock().remove(sid);

        let sink_a = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink_b = Arc::new(Mutex::new(Vec::<u8>::new()));
        let id_a = add_subscriber(sid, counting_sub(sink_a.clone()));
        let id_b = add_subscriber(sid, counting_sub(sink_b.clone()));

        broadcast_data(sid, b"1");
        assert_eq!(&*sink_a.lock(), b"1");
        assert_eq!(&*sink_b.lock(), b"1");

        // Connection A disconnects.
        remove_subscriber(sid, id_a);
        broadcast_data(sid, b"2");
        assert_eq!(&*sink_a.lock(), b"1"); // unchanged
        assert_eq!(&*sink_b.lock(), b"12"); // still live

        remove_subscriber(sid, id_b);
        assert!(SUBSCRIBERS.lock().get(sid).is_none());
    }
}
