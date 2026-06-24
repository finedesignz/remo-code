# Plan Review — m-interactive-pty-runner (Cycle 2, verification re-review)

**Reviewer:** Claude (in-context). **Scope:** verify cycle-2 replans (915cdec, b569e4f, dee1f68) close the
genuine HIGHs H1–H10 from SYNTHESIS-cycle1, with focus on my two prior HIGHs (Phase-17 one-way-door gate +
render-fidelity/mobile-reattach precondition). Read against the CURRENT plans for phases 15/16/17/19/20 in
the worktree (`C:\Users\artic\GitHub\remo-code-feat-interactive-pty-runner`).

## My two prior HIGH (cycle-1) — status

| Prior HIGH | Status | Evidence |
|---|---|---|
| (a) Phase-17 one-way-door gate enforced only by a note file, not mechanically | **CLOSED** | 17-PLAN-002 Task 1 adds `tools/cutover-deletion-gate.mjs` — a standalone Node ESM script that reads the Phase-16 ship-verdict artifact and EXITS NON-ZERO on missing/`FAIL`/`PARTIAL`/absent verdict. Task 3's FIRST action invokes it as a HARD precondition (non-zero ⇒ ZERO deletions; T-17-04b explicitly covers "deletion runs despite absent gate"). `web/test/cutover-deletion-gate.test.ts` drives 5 fixtures incl. abort-on-missing + abort-on-FAIL. Mechanically enforced, not prose. |
| (b) Render-fidelity / mobile-reattach precondition manual-only, not read by the gate | **PARTIAL** | The gate now *consumes* `render_fidelity: PASS` + `mobile_reattach: PASS` (fixtures (d)/(e) prove abort when `mobile_reattach` absent or `render_fidelity: FAIL`). Consumer side is solid. BUT the PRODUCER side is not wired — see NEW-H11. So the gate reads a field no phase is committed to emit in the matching shape. |

## Genuine HIGH verdict table (H1–H10)

| # | Phase·Plan | Verdict | Evidence (current plan) |
|---|---|---|---|
| H1 | 16·PLAN-002 T4 | **CLOSED** | `humanOnlyPtyGate` shared chokepoint gates BOTH dispatch pipeline AND the `term.input` relay ingress in `client.ts`; actor SERVER-INFERRED from connection (cookie⇒human / api_key⇒agent), never payload (T-16-10/T-16-11). Tests `human-only-guard.test.ts` + `term-relay-human-guard.test.ts`. Cost-cap composed, not bypassed. |
| H2 | 16·PLAN-002 T2 | **CLOSED** | term.* accepted only when `session_id ∈ THAT conn's subscribedSessions` AND DB-backed `canWriteTerminal(userId, sessionId)`; forged-id rejected (T-16-12). `term-relay-auth.test.ts` cross-user cases. |
| H3 | 16·PLAN-002 T2 | **CLOSED** | `/ws/agent` drops term.* if `session_id ∉` that supervisor's advertised inventory (`supervisor-registry`); T-16-13 + `term-agent-inventory-auth.test.ts` cross-host injection. |
| H4 | 17·PLAN-002 T1 | **CLOSED** | Mechanical gate (same as my prior (a)). |
| H5 | 15–20 PLAN-CHECK/VALIDATION | **CLOSED (hygiene)** | dee1f68 reconciles VALIDATION frontmatter with PLAN-CHECK PASS across all 6 phases. (Did not re-audit every duplicate block byte-for-byte; commit scope matches the H5 item.) |
| H6 | 15·PLAN-001 (+16/17/19) | **CLOSED** | 15-PLAN-001 adds `supervisor/test/pty-spawn-interception.test.ts` — BEHAVIORAL harness intercepting the real `ptySpawn` factory (non-runtime-exported, reused by 16/17/19 per R-PTY-26), asserting real {file,argv,env}; canary fails build on programmatic flag or `ANTHROPIC_API_KEY` in spawned env. Replaces the weak static grep. |
| H7 | 15·PLAN-001 | **CLOSED** | `runner.kill()` wired to session-closure + WS-disconnect; parent-PID dead-man's-switch; `supervisor/test/pty-orphan-teardown.test.ts`. (Synthesis notes it also lands in 16·PLAN-001.) |
| H8 | 19·PLAN-002 | **CLOSED** | Selector `resolveHumanBackend()` resolves to EXPLICIT `claude-pty`\|`codex-pty` only, throws on any non-PTY/legacy id; never bare `claude`/`codex`. Fail-safe default = `codex-pty` until cutover gate confirms PTY billing. Spawn-arg test rejects programmatic flags. |
| H9 | 19·PLAN-001/002 | **CLOSED (per plan text)** | Centralized PTY-spawn env sanitization with denylist `OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY`/SDK env across providers; per-backend spawned-env test. (Verified in PLAN prose + checklist; did not confirm the denylist enumerates every SDK var — see note H9b below.) |
| H10 | 16·PLAN-002 T3 | **CLOSED** | `runner_type TEXT NOT NULL DEFAULT 'stream-json'` via idempotent `ADD COLUMN IF NOT EXISTS`; ALSO nullable `pty_backend_id`/`transcript_path` capturing backend identity + transcript path/id at PTY spawn; resume reads persisted identity (T-16-14 dual-spawn, T-16-15 mis-route). `pty-runner-resume-identity.test.ts`. |

**Counts:** CLOSED 9 (H1,H2,H3,H4,H6,H7,H8,H9,H10) + H5 closed-hygiene · PARTIAL 1 (my prior (b), via NEW-H11) · OPEN 0.

## NEW HIGH introduced / surfaced by the cycle-2 additions

- **NEW-H11 [HIGH] — Phase-16 never EMITS the verdict artifact the Phase-17 gate parses (producer/consumer
  contract gap).** 17-PLAN-002 Task 1 hardcodes a parse for `16-VERIFICATION.md` containing top-level
  `verdict: PASS` + manual fields `render_fidelity: PASS` + `mobile_reattach: PASS`. But Phase-16's
  `16-VALIDATION.md` "Manual-Only Verifications" section lists those proofs only as prose rows keyed to
  R-PTY-07/R-PTY-09 ("Dropped phone connection reattaches…", "Mobile resize/scrollback…") — it does NOT
  emit machine-parseable `render_fidelity:` / `mobile_reattach:` keys, and **no Phase-16 task is assigned
  to write `16-VERIFICATION.md` in that schema.** REQUIREMENTS.md (lines 650/765/767) and the Phase-17
  addendum reference the field names only as the gate's *input expectation* and explicitly punt
  ("Phase-16 verification must EMIT them — pin exact field names at execution"). Consequence in autonomous
  execution: the gate either (a) always aborts (artifact/fields absent) → permanently blocks the rip, or
  (b) the executor hand-creates the file at execution time to satisfy the parser — reintroducing exactly
  the manual-wave-through that H4 was meant to eliminate. **Fix:** add a Phase-16 task (likely under the
  H5 sweep or a 16-PLAN-002 verification task) that EMITS `16-VERIFICATION.md` with the pinned
  `verdict` / `render_fidelity` / `mobile_reattach` keys populated from the gsd-verify-work ship verdict +
  the manual device-test result; pin identical field names + path in both the producer (Phase 16) and the
  gate (Phase 17) so the contract is closed end-to-end, not deferred.

- **H9b [note, not HIGH]** — H9's denylist should be asserted to also cover Codex/Gemini SDK auth vars
  beyond the three named keys (e.g. `OPENAI_BASE_URL`-style creds, `GOOGLE_APPLICATION_CREDENTIALS`). The
  plan centralizes sanitization and tests the spawned env, which is the right shape; flagging only that
  the denylist enumeration should be audited at execution. Not a blocker.

## Overall

- **Prior HIGH:** (a) CLOSED, (b) PARTIAL (consumer closed, producer gap = NEW-H11).
- **H1–H10:** 9 CLOSED + H5 closed-hygiene, 0 OPEN.
- **NEW HIGH:** 1 (NEW-H11 — Phase-16 must emit the verdict artifact the gate parses).
- **Net:** cycle-2 replans substantively close the security cluster (H1–H3), the mechanical gate (H4),
  spawn/teardown integrity (H6/H7), the selector + env scrub (H8/H9), and resume identity (H10). The one
  residual blocker is the producer-side half of the gate contract (NEW-H11) — close it before Phase 17 runs
  autonomously, else the one-way-door gate is either unsatisfiable or quietly hand-waved.

File: `.planning/reviews/claude-cycle2.md`
