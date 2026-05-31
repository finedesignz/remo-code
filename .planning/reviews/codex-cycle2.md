# Codex Adversarial Plan Review — Cycle 2 (verification re-review)

- Reviewer: OpenAI Codex CLI `codex exec` (v0.133.0, model gpt-5.5), non-interactive. **Probe: PROBE_OK.**
- Scope: verify whether the committed cycle-2 replans (915cdec, b569e4f, dee1f68) CLOSE the adjudicated genuine HIGHs (H1–H10) from `SYNTHESIS-cycle1.md`, and flag any NEW HIGH the cycle-2 additions themselves introduce. NOT a fresh broad scan.
- Method: per-phase `codex exec`, plan-file CONTENTS fed inline via stdin (codex's own Windows sandbox cannot `exec` shell file-reads — `windows sandbox: spawn setup refresh` — so all reads were inlined). Verdicts cross-checked by the orchestrator against the actual plan files.
- Note: each phase batch was fed only that phase's plan files, so a HIGH owned by a *different* phase shows OPEN/PARTIAL in a batch where its remediation file wasn't present. Final verdict column is the **adjudicated** verdict after the orchestrator located each remediation in its owning plan.

## Per-HIGH verdict table

| HIGH | Owning plan | Codex raw verdict | Adjudicated verdict | Notes |
|---|---|---|---|---|
| **H1** raw `term.input` human-only at relay boundary, server-inferred actor | 16·PLAN-002 T4 | CLOSED | **CLOSED** | Shared `humanOnlyPtyGate` chokepoint gates dispatch AND relay; actor server-inferred (cookie⇒human / api_key⇒agent), client `source` field ignored; spoof negative test T-16-11. |
| **H2** per-session write authz on `term.attach`/`term.input` | 16·PLAN-002 T2 | CLOSED | **CLOSED** | `session_id ∈ subscribedSessions` AND DB-backed `canWriteTerminal(userId,sessionId)`; named cross-user/cross-session hijack tests in `term-relay-auth.test.ts` (T-16-12). |
| **H3** `/ws/agent` drop `term.*` for session not in supervisor inventory | 16·PLAN-002 T2 | CLOSED | **CLOSED** | Drop if `session_id ∉` advertised `session_inventory`; cross-host injection test `term-agent-inventory-auth.test.ts` (T-16-13). *See NEW-HIGH-1.* |
| **H4** mechanical one-way-door cutover-deletion gate | 17·PLAN-002 T1 | PARTIAL | **PARTIAL** | `tools/cutover-deletion-gate.mjs` exists, reads Phase-16 ship-verdict, non-zero abort, is a hard PRECONDITION of the Task-3 delete + fixture test. **Gap:** gate keys only on verdict + manual render/mobile PASS fields; does NOT assert green `human-only-guard`/`term-relay-auth` test markers, and evidence is markdown/YAML a human can hand-edit (not bound to immutable test-run output). |
| **H6** behavioral spawn-interception test (exact exe/argv/env, tmux builder, provider-key denylist) | 16·PLAN-001 / 17·PLAN-001 | PARTIAL | **PARTIAL** | Argv/constructed-env canaries + no-`-p`/`--input-format`/`--output-format` assertions present for claude-pty; Codex argv canary present. **Gap:** no true interception of `node-pty.spawn` + tmux command-builder asserting the FINAL post-merge spawned exe/argv/env; provider-key denylist test for the spawned env lives in 19·PLAN-003, not at the 16/17 spawn seam. |
| **H7** orphan-PTY teardown + dead-man's-switch | 16·PLAN-001 T2 | PARTIAL | **CLOSED** | Codex misread the deliberate detach-vs-kill policy. Plan explicitly: client WS **disconnect = detach** (keep PTY for reattach, by design); session-close + idle-reap + supervisor SHUTDOWN = **kill**; parent-PID dead-man's-switch kills a non-tmux PTY if the supervisor crashes (line 144). Teardown is wired + tested. Verifiable. |
| **H8** explicit `claude-pty`/`codex-pty` ids, no legacy fallback | 19·PLAN-002 | PARTIAL | **PARTIAL** | Selector resolves explicit PTY ids only, throws on any legacy/generic id, fail-safe default = `codex-pty` until gate confirms; negative tests present. **Gap (codex):** no spawn-arg test asserting `-p`/`--input-format`/`--output-format` are rejected on *every human-selected runner* at the selector seam (the flag canary lives in 16/17, not re-asserted post-selection in 19). |
| **H9** centralized multi-provider env scrub | 19·PLAN-003 T3 | PARTIAL | **PARTIAL** | Single shared `env-sanitize.ts` denylists ANTHROPIC/OPENAI/GEMINI/GOOGLE_API_KEY + GOOGLE_APPLICATION_CREDENTIALS + ANTHROPIC_AUTH_TOKEN, scrubs INHERITED env, tested on the ACTUAL post-merge spawned env per backend. **Gap (codex):** denylist (not allowlist) can miss future/aliased creds (`*_AUTH_TOKEN`, `*_ACCESS_TOKEN`, SDK config-path vars). Design-acceptable but allowlist would close harder. |
| **H10** persist backend transcript path/id at PTY spawn | 16·PLAN-002 T3 | PARTIAL | **PARTIAL** | Schema adds nullable `pty_backend_id`/`transcript_path`; resume reads persisted identity (no dual-spawn); tests T-16-14/T-16-15. **Gap:** spawn-time *capture+write* of the real Claude/Codex transcript id is delegated to runner impl with no explicit "spawn writes transcript_path" assertion — the Phase-20 `TranscriptSource` dependency rides on an untested write. |

## Counts
- **CLOSED: 4** — H1, H2, H3, H7
- **PARTIAL: 5** — H4, H6, H8, H9, H10
- **OPEN: 0**

No genuine HIGH is fully OPEN; all have remediation present. The 5 PARTIALs are tightenings of mechanism/test-binding, not missing remediations.

## NEW HIGH introduced by the cycle-2 additions

| # | Title | Phase | Concern |
|---|---|---|---|
| NH-1 | Supervisor `session_inventory` is self-asserted (H3 trust gap) | 16·PLAN-002 | The H3 drop-check trusts the supervisor's own advertised inventory. A compromised/buggy supervisor can advertise a victim's `session_id` and pass the H3 check — the inventory is not cross-validated against a DB record of which host legitimately owns that session. |
| NH-2 | Terminal frame **direction** not allowlisted per socket | 16·PLAN-002 | Nothing explicitly forbids `term.input` (a write) arriving on `/ws/agent`. An inventory-valid agent socket could become an input path; the relay should allowlist directions per socket (input only from `/ws/client`, data only from `/ws/agent`). |
| NH-3 | `cookie⇒human` lacks Origin/CSWSH enforcement | 16·PLAN-002 | The human/agent actor inference treats ANY authenticated browser WS as human. Without strict Origin / cross-site-WebSocket-hijack enforcement on `/ws/client`, a cross-site socket could drive PTY input as "human" and bypass the human-only intent. |
| NH-4 | Cutover gate is operationally bypassable / evidence hand-fakeable | 17·PLAN-002 | The gate aborts the delete *task* via non-zero exit, but it is invoked by task text, not a CI-required wrapper around the actual `rm`; and it parses markdown/YAML PASS fields not bound to immutable test-run outputs, so a human can forge a PASS verdict. (Overlaps the H4 PARTIAL gap.) |
| NH-5 | Denylist env-sanitizer (vs allowlist) | 19·PLAN-003 | Denylist scrubbing leaves unlisted/future provider credential aliases and SDK config-path vars on the spawned child env; a child-env **allowlist** would be the harder guarantee. (Overlaps the H9 PARTIAL gap.) |

NH-4/NH-5 are the mechanism-level expression of the H4/H9 PARTIAL gaps; NH-1/NH-2/NH-3 are genuinely new attack surfaces the relay-boundary cycle-2 additions create at the `/ws/agent` ↔ inventory ↔ cookie-actor seam.

## Bottom line
Cycle-2 closed the four authz/lifecycle HIGHs cleanly (H1/H2/H3/H7). Five remain PARTIAL — all are test-binding / mechanism-hardening tightenings, not absent remediations: bind the H4 gate to test-run output + a CI delete-wrapper, add a real `node-pty.spawn`/tmux interception harness for H6, re-assert the flag canary at the H8 selector seam, prefer an allowlist for H9, and add an explicit spawn-writes-transcript_path test for H10. Newly-introduced surface to address before Phase 16 ships: NH-1 (inventory self-assertion), NH-2 (per-socket frame-direction allowlist), NH-3 (Origin/CSWSH on `/ws/client`).
