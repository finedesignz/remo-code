# Gemini adversarial plan review — cycle 1

Reviewer: `gemini -p` (CLI, non-interactive). Status: AVAILABLE (PROBE_OK).
Scope: Phases 15–20 of milestone `m-interactive-pty-runner`. One gemini call per phase,
fed the phase PLAN/CONTEXT artifacts inline plus the SPEC hard-constraints (C1–C6) and a
HIGH/MED/LOW rubric. Findings below are gemini's, lightly deduped; ratings are gemini's.

Constraint legend: C1 no API key / no API-key fallback · C2 official client only, no token
reuse/serialize · C3 human-only PTY guard · C4 interactive-only (no -p/stream-json) ·
C5 prove-before-delete sequencing · C6 Telegram fail-closed + (sessionId,requestId) + turn lock.

---

## Phase 15 — pty-spike-and-compile-derisk

- [HIGH] 15 Orphaned PTY process leak — PLAN-002 wires start/write/resize but not `runner.kill()` to session teardown / WS disconnect; leaves zombie `claude` + `pty.exe` host procs (memory, file locks). — Hook `runner.kill()` to supervisor session-closure + WS-disconnect lifecycle in `supervisor/src/index.ts`.
- [HIGH] 15 Tauri updater ABI mismatch — if PLAN-003 ships native `pty.node` beside the compiled sidecar, the updater replaces only the exe; an old `.node` against a new exe = hard Node ABI crash on next update. — Record in SPIKE-FINDINGS that approach (a) requires updater bundle config to package + replace the `.node` atomically with the sidecar.
- [MED] 15 WS congestion / unbuffered PTY data — `node-pty.onData` fires tiny chunks during TUI repaints; one WS frame per chunk floods hub + React. — Add a 5–15ms buffer/throttle in the pty runner before emitting `term.data`.
- [MED] 15 Directional enforcement for C3 — branch before the structured switch must actively reject wrong-direction frames. — Drop any `term.input` arriving on `/ws/agent` and any `term.data` on `/ws/client`.
- [MED] 15 Zod runtime validation not bypassed — branching "before the structured-message switch" must still `.parse()` term frames; malformed base64/resize could crash hub/PTY host. — Enforce strict `term-protocol.ts` Zod parse before forwarding.
- [LOW] 15 Unsafe initial terminal dimensions — passing 0/null/NaN cols/rows to node-pty crashes the supervisor. — Fallback to `cols:80, rows:24` on invalid inbound dims.

## Phase 16 — hardened-pty-relay-and-mobile-terminal

- [HIGH] 16 Hub routing trust / PTY hijack — relaying `term.*` by client-supplied `session_id` lets a client inject input into any active PTY. — Validate the frame's `session_id` is in the socket's `subscribedSessions` before relaying.
- [HIGH] 16 Dispatch-source integrity (C3) — `humanOnlyPtyGate` is bypassable if `source` is client-asserted vs server-inferred. — Derive `source` strictly from the hub auth context (api_key vs user cookie) in `hub/src/dispatch/pipeline.ts` so automation can't spoof a human turn.
- [MED] 16 Windows persistence gap — tmux is POSIX-only; Windows supervisor restarts lose PTY state (dev/prod reliability skew). — Surface a Windows "session state" warning, or a lightweight persistent node-pty host on Windows.
- [MED] 16 Zombie process leakage on supervisor crash — node-pty children + tmux sessions orphan. — Dead-man's switch (parent-PID poll / `process.on('disconnect')`) so the PTY self-terminates if the supervisor dies.
- [MED] 16 Aggregate ring-buffer OOM — many "bounded" per-session buffers sum to a memory-exhaustion DoS. — Global `MAX_TOTAL_PTY_BUFFER_MB` cap with LRU eviction of inactive sessions.
- [MED] 16 TUI reattach desync — blindly replaying raw bytes corrupts a mid-draw TUI / changed dims. — On `term.reattach`, send SIGWINCH/clear before replaying buffer to force a repaint.
- [MED] 16 Native-module load path in prod sidecar — "Phase-15 shipping approach" as a black box; dev `bun run` success ≠ compiled-sidecar `.node` load. — PLAN-001 must verify loading native node-pty from the production sidecar directory.
- [LOW] 16 Base64/JSON relay overhead — Zod+base64 per frame adds CPU/latency. — Consider raw binary WS frames for `term.data`/`term.input`.

## Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace

- [HIGH] 17 C1 — explicit key deletion not mandated — PLAN-001 says "env hygiene" but does not pin `delete env.ANTHROPIC_API_KEY` in `codex-pty-runner.ts`. — Mandate the exact line in PLAN-001 Task 1. (Note: reviewer may not have seen claude-pty parity; verify it is actually present, not just implied.)
- [HIGH] 17 C4 — Codex interactive argv left as open research — wrong entrypoint may default to a pipe, violating interactive-only. — Resolve research and lock the exact interactive argv in PLAN-001 Task 1 before the rip depends on it.
- [MED] 17 Grid view functional regression — PLAN-002 permits "dropping conversation rendering" in GridPage as smallest-diff; kills multi-session monitoring. — Require GridPage to host `TerminalSurface` cells for parity (tie to R-PTY-15).
- [MED] 17 Headless operator-confirmation stall — PLAN-001 wants operator confirmation of the Codex argv; non-interactive GSD env stalls or guesses. — Provide the validated argv in the task instead of a runtime confirmation gate.
- [MED] 17 Telegram bridge resource leak on partial rip — PLAN-003 removes the event source but keeps the module + approvals shell; orphaned listeners/intervals persist. — Explicitly halt/unsubscribe background work in `bridge.ts` during the rip (Phase 20 re-sources it).
- [MED] 17 Hub protocol dead code — "PRESERVE on ambiguity" risks ghost broadcast logic with no consumer. — Verify each preserved protocol path has a live consumer (automation runner) or remove it.
- [LOW] 17 Orphaned ChatSurface CSS/assets — deleting components but not their Tailwind layers/images leaves rot. — Add a style/asset cleanup task.

## Phase 18 — billing-guardrail-dual-bucket-usage

- [HIGH] 18 Human-PTY cost-cap bypass claim — PLAN-003 states the human PTY path "does not flow through `dailyCostCapGate`," in tension with the non-bypassable-cost-cap invariant. (Counterpoint: SPEC intentionally exempts human interactive turns from the halt per R-PTY-18a — but the *gate* and the *halt predicate* are distinct; bypassing the gate entirely loses the global USD ceiling visibility.) — Keep all dispatch flowing through the gate; make `programmatic_halt` a conditional predicate on `dispatch_source`, not a gate bypass.
- [HIGH] 18 Leak-detector race / false positives — point-in-time "in-flight automation" check + 5-min poll + delayed Anthropic reporting → alert fires whenever automation finishes just before a poll. — Correlate the usage delta against the `token_usage` ledger for the interval since last poll, not live in-flight status.
- [MED] 18 OAuth scope for the programmatic pool (C2) — poll assumes the existing token can read the new credit pool; may need a new scope/endpoint. — Research-verify scope/endpoint against a live Max account; ensure no manual token extraction.
- [MED] 18 Halt-on-unknown lockout — nullable `programmatic_credit`; if halt logic treats `null` as 0 it locks out. — `isOverProgrammaticHalt` must return false (no halt) when balance is null/unknown.
- [MED] 18 C3 guard verification mechanism unspecified — if the guard checks a client-controllable property it's bypassable. — Enforce at hub/runner boundary on the authenticated SessionContext (human vs service account), immutable for the session.
- [LOW] 18 Leak-alert persistence — dismissible/non-blocking alert may hide an ongoing drain. — Persist an "unacknowledged leak" state until a balance-delta shows the drain stopped.

## Phase 19 — cutover-gate-and-automation-fallback

- [HIGH] 19 C3 runtime enforcement gap — selector routes humans but PtyRunner itself doesn't hard-reject if automation reaches it via a bypass. — `PtyRunner.spawn()` throws `PTY_REJECT_AUTOMATION` when `isHuman` is false (defense in depth).
- [HIGH] 19 Gate-check measurement blind spot — single-turn snapshot-diff misses *delayed* session-wide reclassification after N minutes of supervisor-parented activity. — Add a 30+ min "duration soak" of intermittent human activity before the final billing diff.
- [HIGH] 19 Missing C4 flag negative test — guards API keys but not against `--print`/`--output-format stream-json` sneaking onto the PTY spawn. — Extend the guard test to assert forbidden programmatic flags are absent from the generated argv.
- [HIGH] 19 setup-token serialization (C2) — Check 2 names `setup-token` as remote-auth fallback without prohibiting its serialization to the hub. — Negative test: setup-token stays local to supervisor ephemeral memory, never serialized/persisted.
- [MED] 19 Fallback auth deadlock — Codex fallback with no prior `codex login` hangs on an invisible auth prompt. — `resolveHumanBackend` checks candidate auth-status and returns a `NeedsAuth` state with in-terminal sign-in instructions.
- [MED] 19 Cross-backend env/config pollution — swapping Claude/Codex on one surface risks env-var/config collisions. — Session-scoped, isolated env blocks + per-spawn config dir.
- [MED] 19 Single-writer lock not wired into Phase-20 prep — supersession of R-PTY-24 documented but transcript write-ownership not pinned. — Define the PTY runner as exclusive transcript write-stream owner in Phase-20 prep docs.
- [LOW] 19 Gemini stub ghost UX — a stubbed/sunset Gemini seam appearing in backend menus confuses users. — Filter `not-implemented`/sunset stubs out of public backend lists.
- [LOW] 19 Checklist machine-readability — Markdown checklist is brittle for "machine-checkable" gates. — Use `gate-checks.json` as source of truth, generate the Markdown from it.

## Phase 20 — telegram-transcript-tail

- [HIGH] 20 TOCTOU on stale approvals (C6) — async transcript tail: xterm user answers + advances the TUI just before a Telegram tap; the tap's keystroke lands in the *next* TUI state → unintended action. — Validate pending state is synced at injection time / debounce against recent xterm activity; reject if `(sessionId,requestId)` already resolved (SPEC requires this — confirm the plan actually checks resolved/expired/superseded before inject).
- [HIGH] 20 Mid-turn interleaving for responses (C6) — PLAN-004 lets the permission RESPONSE path bypass the turn-acquire; concurrent xterm keystrokes interleave with the injected bytes on stdin. — Responses must take a short-lived micro-lock that pauses xterm relay for the byte injection.
- [MED] 20 Partial JSONL line dropping — `fs.watch` tail reads partial chunks; `JSON.parse` fails → "unknown type ⇒ skip" silently drops valid permission/assistant entries. — Buffer trailing bytes; only parse on a complete `\n` boundary.
- [MED] 20 Unsafe lock release via wall-clock TTL — releasing the turn lock purely on a timer while the model is still generating lets the next writer inject mid-generation. — TTL fallback must also confirm PTY idle (no stdout for N ms) before forced release.
- [MED] 20 Turn-lock registry memory leak — module-level `Map<sessionId,...>` with no cleanup leaks per completed session. — Wire `turnLock.delete(sessionId)` to session exit/close.
- [MED] 20 Brittle Claude project-slug derivation — deterministic slug to locate the JSONL silently fails if Anthropic changes the slug algorithm. — Runtime startup check that the computed JSONL path exists; loud warning on drift. (Aligns with SPEC "resolve explicitly, never newest-file guessing.")
- [LOW] 20 Silent hang in Codex scrape fallback — fail-closed (no perms) is correct, but Telegram users see zero output at a permission halt and assume breakage. — Emit a read-only "manual intervention required in local terminal" notice on extended idle prompt.

---

## HIGH summary (phase → count)

- Phase 15: 2 — orphaned-PTY-process-leak, tauri-updater-ABI-mismatch
- Phase 16: 2 — hub-routing-trust/PTY-hijack, dispatch-source-integrity(C3)
- Phase 17: 2 — C1-explicit-key-delete-not-mandated, C4-codex-argv-open-research
- Phase 18: 2 — human-PTY-cost-cap-bypass-claim, leak-detector-race
- Phase 19: 4 — C3-runtime-enforcement-gap, gate-measurement-blind-spot, missing-C4-flag-test, setup-token-serialization(C2)
- Phase 20: 2 — TOCTOU-stale-approvals(C6), mid-turn-response-interleaving(C6)

Total: HIGH 14 · MED 23 · LOW 8.

Reviewer notes / caveats for the planner:
- Several HIGH items may already be addressed in code/plan text the reviewer didn't fully resolve
  (e.g. 17-C1 parity with `claude-runner.ts:94`; 20 (sessionId,requestId) resolved-check is in the
  SPEC). Treat those as "verify the plan/test makes it explicit," not necessarily new gaps.
- The 18 cost-cap "bypass" finding partly conflicts with the deliberate SPEC design (humans exempt
  from the *halt*); the actionable core is keep the *gate* in-path, scope only the *predicate*.
