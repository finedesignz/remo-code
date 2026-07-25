---
status: passed
reconciled: 2026-06-14
reconciliation_note: "Build shipped + live in prod 2026-06-04 (#244/#246, supervisor v0.9.0). The original 2026-06-01 verdict was PARTIAL ONLY on the two on-device manual attestations (render_fidelity / mobile_reattach); the automatable suite was all green. Those attestations are tracked as cutover-gated items in docs/cutover-gate-june15.md, not phase-build blockers. Status reconciled to passed for GSD stats; original machine-emitted frontmatter preserved below."
verdict: PARTIAL
render_fidelity: FAIL
mobile_reattach: FAIL
automated_suite:
  result: PASS
  command: "bun run check-baseline"
  summary: "pass=1181 skip=130 fail=0 total=1311"
  run_at: "2026-06-01T15:19:48.545Z"
term_relay_auth:
  result: PASS
  tests: [term-relay-auth, term-relay-human-guard, term-agent-inventory-auth, term-frame-direction-allowlist, term-ws-origin-guard, pty-runner-resume-identity]
  run_at: "2026-06-01T15:19:48.545Z"
manual_attestation:
  render_fidelity: { by: "", at: "", device_build: "" }
  mobile_reattach: { by: "", at: "", device_build: "" }
independent_verification:
  verifier: "Claude (gsd-verifier, independent)"
  verified_at: "2026-06-01"
  verdict: PARTIAL
  automatable_all_green: true
  mislabeled_manual: false
  baseline: "pass=1181 skip=130 fail=0 total=1311"
  hub_term_pty_suite: "46 pass / 0 fail (10 files)"
  supervisor_web_pty_suite: "26 pass / 0 fail (7 files)"
  canary_behavioral_proof: "flag-injection into pty_host.rs => 1 fail; restored"
  sole_gap: ["R-PTY-07 phone reattach attestation", "R-PTY-09 mobile resize/scrollback attestation"]
---

# Phase 16 — Ship Verdict (machine-emitted; do NOT hand-edit)

This artifact is EMITTED by `tools/emit-phase16-verdict.mjs`. The two automated
signals are bound to real `bun run check-baseline` / named-test exit codes; the two
manual signals require an operator attestation triplet (by + ISO-8601 at + device/build).
The Phase-17 `cutover-deletion-gate.mjs` consumes THIS file via the shared schema.

---

# Independent verification (gsd-verifier, goal-backward)

**Verifier:** Claude (independent) · **Verified:** 2026-06-01 · **Branch:** `feat/interactive-pty-runner`
**Worktree:** `C:\Users\artic\GitHub\remo-code-feat-interactive-pty-runner`
**Verdict: PARTIAL** — every automatable goal is GREEN; the *only* gap is two on-device
operator attestations (R-PTY-07 phone reattach, R-PTY-09 mobile resize/scrollback) that code
cannot fabricate. Nothing automatable was mislabeled "manual." Status PARTIAL is correct, and the
Phase-17 cutover-deletion-gate is correctly BLOCKED until those two attestation triplets are filled.

This section is an INDEPENDENT re-check against the codebase (not the implementer's self-report).
Each claim below was read in source and/or executed by the verifier in its own process.

## 1. Rust ConPTY spike — REAL (PASS)
- `supervisor/tauri/src-tauri/src/pty_spike.rs` + `pty_host.rs` + `pty-spike/Cargo.toml` all present.
- `portable-pty` used (`native_pty_system().openpty()` + `CommandBuilder`). Confirmed in both files.
- Spawn contract confirmed in BOTH spike and production host: `CommandBuilder::new("claude")` with
  **EMPTY argv**, `env_remove("ANTHROPIC_API_KEY")`, **no** `-p` / `--print` / `--input-format` /
  `--output-format` / stream-json. Spike additionally aborts (exit 2) if `ANTHROPIC_API_KEY` is set.
- Spike verdict recorded **PASS -> Option C** in `16-SPIKE-FINDINGS-rust-conpty.md`: 1333 bytes of
  genuine interactive TUI captured (ANSI screen control, not a `-p` stream) + 32-byte byte round-trip.

## 2. Spawn-contract canary — REAL + behaviorally enforcing
- Test file: `supervisor/test/no-api-key-no-streamjson-pty.test.ts` (globs BOTH host branches:
  Option-A `claude-pty-runner.ts`/`pty-host.mjs`, Option-C `pty_host.rs`/`claude-pty-bridge.ts`).
- Strips comments first, then scans code for `FORBIDDEN_FLAGS` (`--input-format`/`--output-format`/
  `--print`/`stream-json`), quoted `-p`, and asserts `ANTHROPIC_API_KEY` only ever appears adjacent to
  `delete`/`env_remove`/`remove`.
- **Behavioral proof (verifier-run):** injected `cmd.arg("--input-format"); cmd.arg("stream-json")`
  into `pty_host.rs` in-sandbox -> canary went **1 fail** (NO host file contains a programmatic flag
  token). File restored. The guard genuinely breaks on reintroduction.

## 3. term.* channel isolation — REAL
- `hub/src/ws/term-protocol.ts` imports NEITHER `agent-protocol` NOR `protocol`, never references
  `RunnerEvent`. Carries opaque base64 bytes.
- Relay short-circuits **BEFORE** `*Inbound.safeParse` in both `hub/src/ws/client.ts:144` (before
  `ClientInbound.safeParse` at :184) and `hub/src/ws/agent.ts:170` (before `AgentInbound.safeParse`).
- Byte-faithful (frame forwarded as-is), **license-gated** (`isLicenseActive` on `term.input`),
  and writes **no** `messages` row (no `insertMessage` in the term branch).
- Enforcing test: `hub/test/term-channel-isolation.test.ts` — asserts no RunnerEvent/agent-protocol
  import, term branch index < safeParse index in both handlers, and `insertMessage` absent from branch.

## 4. Human-only guard — REAL, server-inferred actor
- `hub/src/dispatch/gates.ts`: `AUTOMATION_ACTORS = {scheduler, orchestrator-background, auto-dev,
  error-capture}`; `humanOnlyRejectsActor(actor, runnerType)` = for `pty-interactive`, **any non-`human`
  actor rejected** (default-deny). Applied at dispatch (`humanOnlyPtyGate` ->
  `automation_blocked_on_pty:<actor>`) AND on the relay (`client.ts` infers actor `'human'` from the
  authenticated cookie connection — never a payload field).
- Enforcing tests: `hub/test/human-only-guard.test.ts` + `hub/test/term-relay-human-guard.test.ts`.

## 5. detach-vs-kill — REAL
- `pty_host.rs handle_connection`: bridge socket **DISCONNECT -> DETACH** (PTY + scrollback survive in
  `SESSIONS`); `kill` frame / `session_kill` / `kill_all` (shutdown) -> KILL; reader-thread EOF reaps the
  registry entry. Process-ownership dead-man's-switch (supervisor crash tears down children).
- Enforcing test: `supervisor/test/pty-reattach-persistence.test.ts` — disconnect detaches (killed=0,
  reattach replays scrollback), `session_close` kills (killed=1), idle-reap kills after grace.

## 6. schema.sql — idempotent, no inline backfill
- Phase-16 DDL: `ADD COLUMN IF NOT EXISTS runner_type ... DEFAULT 'stream-json'`, a guarded
  `CHECK` constraint via `information_schema.check_constraints` existence test, and nullable
  `pty_backend_id` / `transcript_path`. All idempotent; comments explicitly state NO backfill (honors
  the schema.sql-re-runs-every-boot invariant).

## 7. Test execution (verifier ran, JWT_SECRET set) — fail=0
- `bun run check-baseline`: **pass=1181 skip=130 fail=0 total=1311** — `OK — within tolerance`.
  (Matches `16-VALIDATION.md` claim exactly.)
- Hub term/pty suite (10 files): **46 pass / 0 fail**.
- Supervisor + web PTY suite (7 files): **26 pass / 0 fail**. (A `node-pty`
  `conpty_console_list_agent` `AttachConsole failed` line appears — that is a spawned helper
  subprocess on this headless run, NOT a test assertion failure; the runner reports 0 fail.)

## Assessment of the PARTIAL claim
- The two FAIL signals (`render_fidelity` / `mobile_reattach`) map to R-PTY-09 (mobile
  resize/scrollback/keyboard-viewport on a real device) and R-PTY-07 (phone reattach across a real
  network drop). Both require a physical device + on-screen keyboard/orientation + a real wifi drop —
  genuinely non-automatable. The automatable cores of both (frame construction, reattach replay,
  session-id filtering, resize/input framing) ARE covered by `web/test/terminal-surface.test.tsx`
  via the `openTermWs` seam, and the PTY survival/scrollback core is covered by
  `pty-reattach-persistence.test.ts`. No automatable item was deferred to dodge it.
- **The two device attestations are the ONLY gap.** Status PARTIAL is correct (NOT FAIL — no
  automatable item is broken). The Phase-17 `cutover-deletion-gate.mjs` is correctly BLOCKED:
  `manual_attestation.{render_fidelity,mobile_reattach}` triplets (by + ISO-8601 at + device/build)
  are empty and `tools/emit-phase16-verdict.mjs` will not flip them without an operator.

**Remaining manual gate (exact):** an operator must, on a real phone build, (a) prove R-PTY-07 —
drop wifi mid-turn and reconnect, same session + scrollback intact — and (b) prove R-PTY-09 — rotate +
open the on-screen keyboard + scroll back, cols/rows track and scrollback reachable; then record the
`by`/`at`/`device_build` triplet for each into the `manual_attestation` block above.

---

_Independently verified: 2026-06-01 · Verifier: Claude (gsd-verifier)_
