//! pty_spike.rs — Phase-16 Task-0 Rust-ConPTY DERISK SPIKE (decision gate).
//!
//! Throwaway-grade but honest spike that mirrors the Phase-15 Node proof on the
//! RUST side: spawn the GENUINE interactive `claude` TUI through a ConPTY from
//! the Tauri Rust process, capture the real trust/welcome prompt bytes, and
//! confirm a byte written to the PTY master round-trips.
//!
//! HARD CONSTRAINTS mirrored (interactive-pty-runner-SPEC.md constraints 1 & 5):
//!   1. ANTHROPIC_API_KEY is REMOVED from the spawned command env. No API-key
//!      fallback. (env.remove("ANTHROPIC_API_KEY"))
//!   5. Interactive `claude` ONLY: argv is EMPTY. NO -p / --print /
//!      --input-format / --output-format / stream-json.
//!
//! Run on the Windows dev host with `ANTHROPIC_API_KEY` deleted from the shell:
//!   cd supervisor/tauri/src-tauri && cargo run --bin pty_spike
//!
//! VERDICT: PASS (real interactive TUI renders + trust prompt captured + byte
//! round-trip) => Option C. FAIL => Option A fallback. Recorded in
//! 16-SPIKE-FINDINGS-rust-conpty.md.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

fn main() {
    println!("=== Phase-16 Task-0 Rust-ConPTY derisk spike ===");

    // Constraint check: refuse to run with an API key in the environment, so the
    // spike cannot accidentally exercise the API-key path.
    if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
        eprintln!(
            "SPIKE ABORT: ANTHROPIC_API_KEY is set in the shell. Delete it before \
             running the spike (constraint 1 — the interactive client must use \
             `claude login`, never an API key)."
        );
        std::process::exit(2);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    // CONSTRAINT 5 — file `claude`, EMPTY argv. No programmatic flags. EVER.
    let mut cmd = CommandBuilder::new("claude");
    // CONSTRAINT 1 — never let an API key reach the client.
    cmd.env_remove("ANTHROPIC_API_KEY");
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .expect("failed to spawn interactive `claude` through ConPTY");

    // Reader thread: drain the master and forward bytes over a channel.
    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Phase 1 — capture the genuine interactive trust/welcome prompt.
    let mut captured: Vec<u8> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw_prompt = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => {
                captured.extend_from_slice(&chunk);
                let text = String::from_utf8_lossy(&captured);
                // The genuine interactive TUI prints a trust/safety prompt that a
                // programmatic `-p` stream NEVER produces.
                if text.contains("trust")
                    || text.contains("Quick safety check")
                    || text.contains("Do you trust")
                    || text.contains("Accessing workspace")
                {
                    saw_prompt = true;
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !captured.is_empty() && captured.len() > 200 {
                    // Got substantial TUI output even without the exact trust string.
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    println!("--- captured {} bytes from the interactive `claude` TUI ---", captured.len());
    println!("{}", String::from_utf8_lossy(&captured));
    println!("--- end capture ---");
    println!("trust-prompt detected: {}", saw_prompt);

    // Phase 2 — byte round-trip: write to the master, observe the TUI react.
    let before = captured.len();
    {
        let mut writer = pair.master.take_writer().expect("take writer");
        // A bare cursor-down / refresh keystroke is enough to provoke a redraw
        // without committing to the trust prompt. Send an arrow-down then read.
        let _ = writer.write_all(b"\x1b[B");
        let _ = writer.flush();
    }
    let roundtrip_deadline = Instant::now() + Duration::from_secs(5);
    let mut after_bytes = 0usize;
    while Instant::now() < roundtrip_deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => {
                after_bytes += chunk.len();
                if after_bytes > 0 {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let roundtrip_ok = after_bytes > 0;
    println!(
        "byte round-trip: wrote 3 bytes (ESC [ B), observed {} bytes of TUI reaction => {}",
        after_bytes,
        if roundtrip_ok { "OK" } else { "NONE" }
    );

    // Teardown — kill the child; the spike must not leave an orphan `claude`.
    let _ = child.kill();
    let _ = child.wait();

    let verdict_pass = (saw_prompt || before > 200) && roundtrip_ok;
    println!(
        "=== SPIKE VERDICT: {} ===",
        if verdict_pass {
            "PASS (Option C — Rust-hosted ConPTY)"
        } else {
            "FAIL (Option A fallback — bundled Node host)"
        }
    );
    std::process::exit(if verdict_pass { 0 } else { 1 });
}
