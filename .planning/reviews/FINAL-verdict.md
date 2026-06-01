# FINAL Convergence Verdict — m-interactive-pty-runner (cycle-3, read-only review)

- **Scope:** read-only verification of cycle-3 closures (commit `3a229fa`) against the CURRENT plan files for Phases 16, 17, 19.
- **Reviewer:** in-context FINAL reviewer (no CLI shell-out). Convergence loop at its 3-cycle cap.
- **Sources read:** `16-PLAN-002`, `17-PLAN-001`, `17-PLAN-002`, `19-PLAN-002`, `19-PLAN-003` (+ their `<verification>`/`must_haves` blocks).

## Per-item verdict table

| Item | Where it lives | Acceptance present? | Verdict |
|---|---|---|---|
| **H11 / NH-4** — shared verdict artifact schema, test-bound provenance, producer↔consumer no-drift | PRODUCER: `16-PLAN-002` Task 5 (`tools/emit-phase16-verdict.mjs` → fixed-path `16-VERIFICATION.md`, `hub/test/phase16-verdict-artifact.test.ts`). CONSUMER: `17-PLAN-002` Task 1 (`tools/cutover-deletion-gate.mjs`, `web/test/cutover-deletion-gate.test.ts`). | YES. BOTH tasks `read_first` the SAME `16-PLAN-002 §shared_verdict_artifact_schema` as single source of truth; gate keys off that anchor, explicitly "Do NOT re-define the shape here" → no drift. Anti-forgery: artifact is script-EMITTED (never hand-authored); `automated_suite`/`term_relay_auth` written directly from `check-baseline`/relay-test run; manual signals require `{by,at,device_build}` triplet; emit script REFUSES manual PASS without triplet; gate asserts provenance. Test-bound (`R-PTY-32`). | **CLOSED** |
| **NH-1** — supervisor `session_inventory` self-asserted (H3 trust gap) | `16-PLAN-002` Task 2, `hub/test/term-agent-inventory-auth.test.ts` | YES. Spoofed-inventory entry for a non-owned session dropped via DB host-ownership cross-validation (`R-PTY-35`); explicit negative test case. | **CLOSED** |
| **NH-2** — frame-direction not allowlisted per socket | `16-PLAN-002` Task 2, `hub/test/term-frame-direction-allowlist.test.ts` | YES. `term.input` accepted ONLY on `/ws/client`; `/ws/agent` is output-only `term.data`; `term.input` on `/ws/agent` rejected before relay (`R-PTY-33`). | **CLOSED** |
| **NH-3** — `cookie⇒human` lacks Origin/CSWSH enforcement | `16-PLAN-002` Task 2, `hub/test/term-ws-origin-guard.test.ts` | YES. Disallowed/cross-site Origin handshake on `/ws/client` rejected so a forged-origin socket can't ride the cookie to drive the PTY (`R-PTY-34`). | **CLOSED** |
| **NH-5** — denylist vs allowlist env sanitizer | `19-PLAN-003` Task 3 (`supervisor/src/runners/env-sanitize.ts`, `no-apikey-fallback-guard.test.ts`) | YES. Documented DECISION: named denylist + credential-class PATTERN sweep (`*_API_KEY`/`*_AUTH_TOKEN`/`*_ACCESS_TOKEN`/`*_API_TOKEN`, anchored, case-insensitive) — allowlist-grade coverage of the credential CLASS with explicit rationale against a brittle pure allowlist. Novel-cred test (`FOO_API_KEY`/`MISTRAL_AUTH_TOKEN`) + benign-control survival (`MY_API_KEYBOARD_LAYOUT`/`PATH`). Inherited-env coverage. Per-backend behavioral tests on real spawn path (`R-PTY-36`). | **CLOSED** |
| **Test-binding 1** — literal `delete env.ANTHROPIC_API_KEY` source-pin canary | `17-PLAN-001` Task 3 "LITERAL-LINE PIN" (`no-api-key-no-streamjson-pty.test.ts`) | YES. Canary greps EACH PTY runner (claude + codex) for a `delete env.ANTHROPIC_API_KEY` (or shared `sanitizeSpawnEnv`) site; absence FAILS build. Pins mechanism statically + behaviorally. (Base canary in Phase 15; extended to Codex in 17.) | **CLOSED** |
| **Test-binding 2** — selector→spawn-argv negative test | `19-PLAN-002` Task 2 (`default-backend-selector.test.ts`) | YES. For EACH backend id the selector can return, drive through runner registry to REAL spawn path (H6 node-pty spawn-interception seam) and assert spawned argv contains NONE of `-p`/`--print`/`--input-format`/`--output-format`. Plus fail-safe + hard-reject negatives (legacy id THROWS, `isHuman:false` THROWS, gate-unset⇒codex-pty). | **CLOSED** |

**Closed: 7 / 7** (5 cycle-3 HIGH/NH items + 2 PARTIAL test-bindings).

## NEW-HIGH list

_(none)_

No genuinely new HIGH introduced by cycle-3. The additions are all narrowing closures of prior findings or test-bindings that tighten existing seams (relay-boundary authz, verdict provenance, env hygiene). NH-5's denylist-with-pattern-sweep is a deliberate, justified design decision (not a residual gap): it achieves credential-CLASS coverage without the cross-host brittleness of a pure allowlist, and is bound by a novel-cred test. The producer/consumer schema anchor (H11/NH-4) removes drift surface rather than adding it. No new attack surface, no goal-blocking PLAN-level gap.

## Overall call

**CONVERGED.** All 7 cycle-3 items are present as concrete tasks with verifiable, test-bound acceptance keyed to `R-PTY-32..36` and named test files; producer/consumer schema is single-sourced with anti-forgery provenance; no new HIGH at the plan level.

## Deferred — execution-time real-world unknowns (NOT plan defects)

- **Bun + node-pty viability** on the target host (compile/runtime of the PTY spike) — correctly deferred to execution; de-risked in Phase 15.
- **Post-June-15 billing-class measurement** — interactive-vs-programmatic billing must be empirically confirmed at run time; the gated-flip selector (default `codex-pty` until operator confirms) is the plan-level safeguard.
- **Codex ChatGPT-subscription inclusion + Gemini-tier sunset (June 18 2026) facts** — flagged for re-verification at 19-PLAN-003 execution time.

These are real-world measurements/runtime facts, not plan-completeness gaps, and do not block convergence.
