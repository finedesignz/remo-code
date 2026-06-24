# Codex Adversarial Plan Review — Cycle 1

- Reviewer: OpenAI Codex CLI `codex exec` (v0.133.0, model gpt-5.5), non-interactive.
- Scope: milestone `m-interactive-pty-runner` Phases 15–20 (full rip-and-replace of stream-json ChatSurface → themed xterm.js PTY terminal surface).
- Method: per-phase call, fed the full `interactive-pty-runner-SPEC.md` + that phase's CONTEXT + PLAN-00N + PLAN-CHECK + VALIDATION inline, asked for HIGH/MED/LOW adversarial findings against goal-failure / one-way-door / missed-dependency / security-billing / spec-constraint criteria.
- Totals: **HIGH 51 · MED 49 · LOW 14** (114).

---

## Phase 15 — pty-spike-and-compile-derisk

- [HIGH] 15 Test-command parameter can violate official-client-only — 15-PLAN-002 Task 4 parametrizes the PTY runner command and spawns `node -e`, creating an arbitrary-command seam in the production runner — fix: keep production `ClaudePtyRunner` hardcoded to `claude`; inject a mocked `ptySpawn` or a test-only factory not exported to runtime.
- [HIGH] 15 PTY attach lacks a human-only source model — attach/flag starts a PTY with no frame field or hub check proving sender is a genuine human, making later automation injection easy — fix: define `dispatch_source`/`actor_type` now and reject anything but authenticated interactive browser-origin frames on the PTY path.
- [HIGH] 15 Raw terminal input auth under-specified — "reuse subscribe authorization" may only control receive routing; a client could send `term.input` for a session it owns but isn't actively attached to, or race attach — fix: add explicit `canWriteTerminal(userId,sessionId)` + active-attachment check before forwarding every `term.input`/`term.resize`.
- [HIGH] 15 No per-session backend/mode persisted before wiring PTY — hard-coded env flags/dev toggles let hub/supervisor/web disagree on PTY vs stream-json → dual runner spawn risk — fix: add a persisted/protocol-level `runner_mode:'pty'|'stream_json'` handshake before any PTY attach starts a runner.
- [HIGH] 15 Dual-runner risk asserted, not mechanically prevented — acceptance only states PTY path doesn't instantiate `ClaudeRunner`; no state machine/test enforces single-runner ownership — fix: add supervisor coverage that a PTY session never constructs `ClaudeRunner` and rejects mode change while a runner is live.
- [HIGH] 15 `setup-token` not blocked by any Phase 15 acceptance — defaults to login but adds no canary against spawning/guiding `claude setup-token`, leaving the suspect auth path open — fix: static checks + docs/tests forbidding `setup-token` in runner, setup copy, and supervisor auth flow.
- [MED] 15 "New WS channel" is multiplexed onto existing `/ws/client`+`/ws/agent` schemas — weakens spec isolation if term frames parse in the same handlers — fix: separate terminal subprotocol dispatch fns, or document multiplexing as approved + test term frames never hit structured handlers.
- [MED] 15 Static grep canaries too weak for argv safety — runner could build `['--input'+'-format']`, read flags from config, or env-passthrough — fix: unit-test the actual spawn argv from the factory; deny any non-empty Claude argv in PTY mode.
- [MED] 15 API-key stripping covers only `ANTHROPIC_API_KEY` — no block on alternate Anthropic key env names / explicit env passthrough — fix: denylist Anthropic platform-key env vars + spawn-env tests.
- [MED] 15 Native-pty dependency fallback lacks supply-chain review — autonomous switch to `@homebridge/node-pty-prebuilt-multiarch` changes native binary trust/shipping — fix: make native-dep choice an operator checkpoint with license/platform/signing/packaging notes.
- [MED] 15 Base64-over-JSON terminal bytes risk corrupting control sequences — UTF-8 vs raw-byte boundaries unspecified — fix: shared `Uint8Array<->base64` helpers + control-sequence round-trip tests, not just echo text.
- [MED] 15 No frame size/rate limits in the spike — raw PTY I/O over authenticated sockets can exhaust memory/flood clients (base64 expansion) — fix: max frame size, input rate limits, output chunking in Phase 15.
- [MED] 15 Compile proof has out-of-band escape hatch without install/update safety — could pass spike yet leave Phase 16 undeployable — fix: require the chosen approach installable by existing Tauri/MSI flow or mark Phase 15 failed.
- [MED] 15 `bun install` scoped to `supervisor/` — Bun workspace installs typically need root lockfile update → inconsistent deps — fix: run from repo root, verify `bun.lock` + `supervisor/package.json` together.
- [MED] 15 Web WS protocol/client layer unnamed — implementers may hack local socket sends inside the component — fix: explicit web WS client/state files + typed `sendTermInput`/`sendTermResize`/`onTermData`.
- [MED] 15 Human-input proof doesn't require a real Claude TUI turn until manual Plan 03 — echo can pass while real `claude` fails on ConPTY/alt-screen/paste/focus — fix: make a real-`claude` TUI turn a blocking Phase-15 requirement before 15-02/15-03 complete.
- [LOW] 15 Duplicate `15-PLAN-CHECK.md` content — planning artifact drift signal — fix: remove duplicate + add phase-doc consistency check.
- [LOW] 15 Validation metadata contradicts plan-check verdict — VALIDATION says `nyquist_compliant:false`/`wave_0_complete:false` while PLAN-CHECK says PASS — fix: reconcile before execution.
- [LOW] 15 Theme acceptance relies on no-indigo grep only — xterm could hard-code off-brand palette or ignore token changes — fix: DOM/theme or Playwright screenshot check that xterm reads CSS vars.
- [LOW] 15 "No messages rows" check is manual — term traffic persistence regression would be serious — fix: hub test asserting `term.*` frames never call message persistence.

## Phase 16 — hardened-pty-relay-and-mobile-terminal

- [HIGH] 16 PTY input bypasses human-only dispatch gate — guard is in `dispatch/pipeline.ts` but raw `term.input` from `/ws/client` is a separate relay path abusable by any client token holder — fix: enforce `source===human_interactive` at the `term.input` relay boundary too.
- [HIGH] 16 No agent-side session ownership authorization — term frames route to `/ws/agent` by `session_id` without proving the supervisor owns/advertised that session — fix: agent-session ownership checks + cross-agent/cross-host session_id injection tests.
- [HIGH] 16 "Authenticated client WS" insufficient for terminal attach — no per-session ownership/license revalidation on `term.attach`/`term.input` → live TUI hijack if subscription state stale/forged — fix: DB-backed session-ownership check on attach; reject term frames unless authorized for that session.
- [HIGH] 16 Cost-cap claim incoherent for raw PTY input — direct keystrokes over `term.input` don't flow through the dispatch pipeline where `dailyCostCapGate` runs — fix: drop the cost-cap claim for human PTY turns OR define an explicit PTY turn gate/accounting path.
- [HIGH] 16 tmux path may violate "interactive claude only" unless pinned — `tmux new-session/attach-session` added without static tests that the inner command is exactly official `claude`, no programmatic flags, no API-key env — fix: tests around tmux command construction + env propagation; no shell-string interpolation.
- [HIGH] 16 Static grep canary too weak for API-key/flag guarantees — misses flags/env via helpers, tmux builders, persistence wrappers, config, or indirectly-assembled argv — fix: runtime tests intercepting `node-pty.spawn` + tmux spawn, asserting exact exe/argv/env.
- [HIGH] 16 Telegram guard underspecified, may block Phase 20 — "Telegram-default session can't switch to PTY" conflicts with the Phase-20 transcript-tail move unless the guard is explicitly temporary/human-origin-aware — fix: model Telegram *origin* separately from "Telegram-default session"; block only automation/non-human injections.
- [MED] 16 `runner_type` migration/compat detail thin — `DEFAULT 'stream-json'` insufficient if query models/session-list payloads/types don't carry it across hub/web/supervisor — fix: require DAL, protocol, client types, session-list updates.
- [MED] 16 Frame schema omits replay ordering/session epoch — `term.reattach` replay can interleave stale + live bytes across reconnects/restarts — fix: monotonic sequence/session-instance ids + tests ignoring stale post-detach frames.
- [MED] 16 Byte payload encoding left open ("base64 or binary") — imprecise for Hono/WS client-server compat/testability — fix: lock one encoding now + byte-fidelity round-trip test.
- [MED] 16 Windows persistence overclaims supervisor-restart survival — ring-buffer+persistent-PTY survives browser drop but not supervisor restart; spec wants tmux-backed reattach — fix: downgrade Windows scope explicitly or add restart-survival + mark gating.
- [MED] 16 Idle-reaping references hub code from supervisor — mirrors `hub/src/ws/idle-teardown.ts` with no concrete supervisor lifecycle API/timeout → leaked PTYs or premature kills — fix: define supervisor-owned idle timers/ownership refs/kill conditions in `pty-persistence.ts`.
- [MED] 16 No proof of actual xterm rendering fidelity — tests cover build/no-indigo/switch, not raw-ANSI render/input/resize in-browser — fix: Playwright/component test with mocked term WS + manual live xterm smoke before Phase 17.
- [MED] 16 Mobile keyboard handling asserted not testable — `visualViewport` required but no iOS/Android viewport/focus/IME acceptance — fix: manual device checklist with pass/fail artifacts; block Phase 17.
- [MED] 16 No backpressure/size limits on raw frames — high-freq/large terminal I/O DoS risk over authenticated WS — fix: per-conn frame-size limits, input rate limits, output coalescing + tests.
- [MED] 16 Attach/read perms not separated from write — a viewer who is subscribed could inject keystrokes; live write is more sensitive than chat read — fix: separate authz for `term.input` vs `term.data`/attach + read-only-denial test.
- [MED] 16 No shell-injection safety for tmux session names — session-keyed names/commands without sanitization/argv-spawn requirement — fix: deterministic sanitized tmux ids; never build tmux commands via shell strings.
- [LOW] 16 PLAN-CHECK contradicts VALIDATION status (Nyquist PASS vs `nyquist_compliant:false`/`wave_0_complete:false`) — fix: reconcile to one source of truth.
- [LOW] 16 Duplicate `16-PLAN-CHECK.md` block — divergent-edit risk — fix: single authoritative check.
- [LOW] 16 Required `16-0x-SUMMARY.md` artifacts missing from `files_modified` — incomplete execution tracking — fix: add summaries to `files_modified` or a consistent generated-outputs field.

## Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace

- [HIGH] 17 Missing proof of raw-terminal isolation in Codex wiring — 17-01 "reuse Phase-16 WS" but no test that Codex PTY bypasses `/ws/agent` RunnerEvent/agent-protocol — fix: integration/static test that `cli_kind='codex'+runner_type='pty-interactive'` binds only to raw-terminal channel, never emits RunnerEvent.
- [HIGH] 17 Human-only guard asserted not re-proven for Codex PTY — no automation-source rejection test specific to Codex — fix: test that scheduler/orchestrator-bg/auto-dev/error-capture dispatch to a Codex PTY session is rejected before any PTY write.
- [HIGH] 17 `ANTHROPIC_API_KEY` hygiene scoped too narrowly — tests the env-builder, not the final spawned env after supervisor/global-config/env merges — fix: test the actual spawn invocation env for both ClaudePtyRunner and CodexPtyRunner from the supervisor instantiation path.
- [HIGH] 17 Official-Claude constraint unguarded during rip — no regression that Claude PTY still spawns official `claude` w/o `-p`/stream-json after the new backend branch — fix: keep/extend a Claude-PTY spawn-argv canary (binary=`claude`, no `-p`/`--input-format`/`--output-format`).
- [HIGH] 17 Sequencing gate fakeable by a note file — 17-02 accepts `17-02-PRECHECK.md` + operator text, not a hard dependency on machine-verifiable Phase 15-16 PASS artifacts (this is THE one-way-door safeguard) — fix: require specific Phase-16 PASS artifacts/commands; fail execution if absent; record immutable evidence paths before deletion.
- [HIGH] 17 PLAN-CHECK contradicts VALIDATION (Nyquist PASS vs `false`/`wave_0_complete:false`) — readiness overstated — fix: reconcile before execution; don't mark ready until Wave-0 stubs exist + status matches PASS.
- [HIGH] 17 Automation-preservation test underspecified for all sources — 17-03 only promises "scheduled-style dispatch" — fix: table-driven dispatch-source test proving PTY rejection + stream-json/finalize for scheduler/orchestrator-bg/auto-dev/error-capture.
- [HIGH] 17 Telegram removal may delete Phase-20 reusable approval registry — 17-03 edits `approvals.ts` but Phase 20 reuses `(sessionId,requestId)` keying — fix: preserve registry/authz primitives, only disconnect the structured-event source, keep `(sessionId,requestId)` keying tests.
- [MED] 17 Codex interactive argv deferred into execution — depends on confirming an undocumented/version-unstable entrypoint during impl → unreviewable now — fix: pre-plan spike recording exact Codex interactive argv as a locked input.
- [MED] 17 `files_modified` omits routing/protocol files exposing `runner_type`/terminal metadata — fix: expand scope or state they remain unchanged + how data reaches TerminalSurface.
- [MED] 17 Removing `useChat.ts` risks deleting shared send/subscribe/history still needed — fix: import-graph classification for web hooks, preserve-on-ambiguity.
- [MED] 17 Grid/list "terminal cells vs drop rendering" left open inside a destructive phase — fix: choose + specify grid behavior (incl. mobile) + tests before execution.
- [MED] 17 Static `grep ChatSurface` misses aliased/renamed/inlined bubble renderers — fix: assert absence by event-kind names + route-level render tests for human sessions.
- [MED] 17 Translation classification lacks concrete inventory inputs — "human-UI-only" subjective — fix: require a classification table for thinking/text_delta/tool_use/tool_result/assistant_message/permission_request/user_question/usage_event before removal.
- [MED] 17 Cost-cap preservation only observes post-rip, not non-bypassability — fix: regression that an over-cap automation dispatch is blocked through the preserved stream-json route after the rip.
- [MED] 17 Build verification commands shell-inconsistent (`test -f`/`grep`/`2>$null` in a Windows/PowerShell repo) — fix: provide PowerShell-compatible or Bun/Node portable verification.
- [LOW] 17 Duplicate `17-PLAN-CHECK.md` content — authoritative-verdict ambiguity — fix: single artifact or mark one superseded.
- [LOW] 17 Phase 17 carries docs-like state but docs sync deferred — Telegram outage/default behavior may be lost to users — fix: minimal ROADMAP/phase-status update in 17, full docs rebuild in Phase 20.

## Phase 18 — billing-guardrail-dual-bucket-usage

- [HIGH] 18 Completion gated on post-June-15 endpoint capture — Plan 01/Plan-Check mark capture gating/`autonomous:false`, violating spec "June-15 checks gate default backend, NOT the build" — fix: move capture to Phase 19/manual; Phase 18 completes with unknown/null bucket + dated TODO.
- [HIGH] 18 Hard-halt targets a possibly-unwired gate — repo note says `hub/src/dispatch/` is foundation-only/unwired, so a predicate on `gates.ts` may not protect current scheduler/error-capture automation — fix: prove each real automation path invokes that gate, or add the predicate to actual current chokepoints first.
- [HIGH] 18 UI hard-halt has no persistence API — schema/gates added but no DAL/REST/WS route/auth/CSRF, so toggle+bound can't load/save — fix: user-scoped settings DAL + authenticated endpoint/WS command + tests, then wire UsageTab.
- [HIGH] 18 Enabled hard-halt bypassable by stale/missing usage — after restart/disconnect/null/stale report, `used_usd>=bound` can't evaluate and automation keeps draining — fix: snapshot freshness/period checks; fail closed for enabled hard-halt when snapshot missing/stale, with a visible reason.
- [HIGH] 18 "Alert fires first" not enforced — enabling a bound already below current usage (or first snapshot over bound) can halt without prior alert — fix: server-side enable-confirmation when usage exceeds bound; persist/emit alert before halt can block.
- [HIGH] 18 Automation in-flight signal undefined — Plan 03 depends on an `in-flight-automation flag` but no plan adds source-aware activity tracking across start/finalize/offline/drop — fix: per-user/source automation activity tracker with lifecycle hooks + tests before the detector consumes it.
- [HIGH] 18 Stream-json automation contract conflicts with rip wording — Phase 18 says Phase 17 keeps runner-side stream-json while spec says the structured path is removed after proof → ambiguous automation transport — fix: explicitly split "automation programmatic runner" from the deleted human ChatSurface runner + test only human UI is ripped.
- [HIGH] 18 Human-vs-programmatic gate scope assumed — Plan 03 says human PTY turns skip `dailyCostCapGate` but the predicate has no typed dispatch-source boundary — fix: add `DispatchSource`/`DispatchKind` on gate input; apply programmatic halt only to an explicit automation enum.
- [HIGH] 18 API-key invariant test can miss inherited env — grep-style assertion checks constructed key usage, not whether spawned `claude` inherits `ANTHROPIC_API_KEY` from process env — fix: spawn-level tests for every Claude runner proving the child env deletes it.
- [MED] 18 Parallel Plan 01/02 ordering risks schema drift — both in wave 1, but 02 must mirror 01's field name exactly — fix: make 02 depend on 01 or a shared `ProgrammaticCredit` contract/fixture in Wave 0.
- [MED] 18 Leak detector ignores usage-report lag — credit usage may post after a run completes → false alert on legit automation — fix: compare deltas vs automation activity since previous snapshot with a settlement grace window.
- [MED] 18 Multi-supervisor snapshots can regress state — out-of-order per-host reports overwrite newer `used_usd` — fix: include `observed_at`+billing-period identity; merge monotonically within `resets_at`; ignore stale lower snapshots except on verified reset.
- [MED] 18 Reset semantics underspecified — monthly drop at `resets_at` with no detector/halt handling → false leak deltas / stale halt — fix: treat `resets_at` change as a new bucket period; clear/roll detector + halt comparisons.
- [MED] 18 WS-only leak alert is lossy — no connected web client at emit → user misses the "no silent drain" notice — fix: persist latest active alert in usage store/DB; include in UsageTab initial snapshot until dismissed.
- [MED] 18 Rate-threshold config not planned — Plan 03 references a user threshold with no storage/default/UI/API — fix: define a default threshold + optional config path, or drop "user threshold" from acceptance.
- [MED] 18 OAuth-token exception unreconciled with hard constraint — expands `readAccessToken` polling while spec says never extract/store/reuse the token (even if local) — fix: document a narrow "local usage-poll only" exception in spec, or replace polling with an official-client-mediated usage command.
- [LOW] 18 Phase docs reconciliation incomplete — billing behavior/controls change but only `docs/usage-cost.md` updated — fix: update `.planning/ROADMAP.md` + Phase 18 summary/spec refs.

## Phase 19 — cutover-gate-and-automation-fallback

- [HIGH] 19 Selector can hit old Claude runner — Plan 02 returns generic `claude`/`codex`; a registry with both PTY and legacy stream-json can pick `claude --input-format/--output-format`, violating interactive-only billing — fix: explicit runner IDs `claude-pty`/`codex-pty` + spawn-arg tests rejecting `-p`/`--input-format`/`--output-format` on human paths.
- [HIGH] 19 API-key scrub too narrow — Codex/Gemini fallback can inherit `OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY`/SDK env — fix: centralize PTY spawn env sanitization for all providers + test actual spawn env for Claude/Codex/Gemini.
- [HIGH] 19 Human-only guard not re-asserted at selector seam — no negative tests that automation can't call the PTY backend/raw-input path — fix: tests over every automation source proving PTY writes rejected + automation stays on cost-capped non-human backend.
- [HIGH] 19 Existing Claude-PTY sessions keep leaking after a failed gate — selector governs only NEW sessions, open sessions keep taking human turns if June-15 says Claude-PTY bills programmatic — fix: gate human turns AND creation; disable/unlist Claude-PTY on programmatic result; explicit operator override + alerting.
- [HIGH] 19 Billing measurement misclassifiable by background noise — snapshot→1turn→snapshot diff lacks quiescing/stability/min-delta/repeat/both-or-no-bucket rules — fix: isolated account/host/session, freeze automation, record timestamps/CLI versions, poll until stable, repeat, fail `unknown` on ambiguity.
- [HIGH] 19 Gate flag too weak for the four checks — single `claude_interactive_confirmed` bool can't encode auth mode/setup-token/subagent-hook-MCP leakage/account-date-version/ongoing headless watch — fix: structured decision record requiring all mandatory check statuses before Claude default.
- [HIGH] 19 setup-token documented but not guarded — treated suspect, but nothing prevents remote setup-token use before post-June-15 classification — fix: disabled-by-default setup-token gate/config + tests that unverified setup-token can't enable Claude-PTY default or remote auth.
- [HIGH] 19 Automation stream-json fate contradictory — Phase 17 deletes the stream-json human path while 19 says automation "stays stream-json…or moves to Codex" without defining the retained runner/cost-cap/fallback — fix: explicitly define preserved automation runner(s), kept separate from PTY/raw terminal, + cost-cap tests for scheduler/error-capture/orchestrator.
- [HIGH] 19 Raw-terminal isolation not regression-tested — "same terminal surface" unproven to use raw-terminal WS vs `/ws/agent` RunnerEvent — fix: registry/transport tests that `claude-pty`/`codex-pty` emit bytes-only PTY events, never RunnerEvent bubbles.
- [HIGH] 19 Official-client/OAuth-token invariant unguarded — guards API keys but not accidental credential-file reads/token serialization/unofficial wrapper invocation — fix: tests/static guards that Claude-PTY spawn is official `claude`, credential files never read/serialized, auth client-owned.
- [MED] 19 Gemini can leak into public selection — Plan 03 adds a Gemini seam while Plan 02 allows an "explicitly chosen non-Claude default" — fix: keep Gemini out of `default_human_backend` schema/UI until flagged on; test it can't be selected outside stub tests.
- [MED] 19 Operator flip not tied to checklist evidence — tests only assert no runtime auto-write — fix: selector reads a committed/validated decision record (completed rows, `tested_at`, account/host, auth mode, reviewer).
- [MED] 19 Docs plan omits files it promises to reconcile — `files_modified` lacks ROADMAP/REQUIREMENTS/SPEC — fix: add them to Plan 04 or narrow acceptance.
- [MED] 19 Codex fallback availability assumed — selector can fail-safe to Codex before local Codex CLI subscription sign-in verified — fix: execution preflight verifying Codex CLI auth mode/availability before Codex becomes fallback default.
- [MED] 19 Existing-session backend pinning unspecified — no persisted backend / hub-web-supervisor agreement on `cliKind`, reconnect may switch backend after config change — fix: persist backend at creation, never mutate on reconnect, test reconnect across selector flips.
- [MED] 19 Phase dependency narrative-only — claims deps on 17/18 with no preflight proving terminal-proof artifacts/Codex runner/dual-bucket fields exist — fix: wave-0 dependency check failing if 17/18 summaries or required exports absent.
- [LOW] 19 Grep-style security tests easy to evade (inherited env/wrappers/dynamic imports/renames) — fix: behavioral spawn-env tests primary, static denylist secondary.
- [LOW] 19 Telegram docs imply premature restoration — Plan 04 documents transcript-tail/read-only while Phase 20 unbuilt + Phase 17 leaves Telegram nonfunctional — fix: state Telegram stays disabled until Phase 20 fail-closed parser + single-writer lock ship.

## Phase 20 — telegram-transcript-tail

- [HIGH] 20 No shared transcript fanout — Plans 02/03/04 each imply separate `TranscriptSource` consumption → duplicate tailers, missed offsets, races, inconsistent permission/turn state — fix: one per-session transcript supervisor/event bus fanning entries to Telegram output, permission detector, and turn-lock release.
- [HIGH] 20 Turn-lock release depends on Telegram bridge lifecycle — "release wired by the bridge that opened the source" wedges xterm input for sessions without an active Telegram default or after bridge restart — fix: turn-lock release subscribes to the central transcript service independent of Telegram chat subscriptions.
- [HIGH] 20 `term.input` lock may lock byte frames, not human turns — xterm sends incremental keystrokes; per-frame `acquire` can't know turn start/end and may queue normal typing mid-line — fix: explicit turn framing (hold from first printable input until Enter), with paste + control-key exceptions.
- [HIGH] 20 Permission-response lock-bypass too broad — "response exempt from acquire" can inject into the PTY even when the prompt belongs to a different holder/stale TUI — fix: bypass only when `(sessionId,requestId)` is currently pending, bound to the active holder's turn, and transcript still shows that exact unresolved prompt.
- [HIGH] 20 Stale-tap mitigation lacks a concrete resolved-state source — requires rejecting taps on resolved/new-turn but no registry field/correlation beyond `takePendingPrompt` — fix: pending states `{pending,resolved,superseded,expired}` updated by transcript entries; check immediately before injection.
- [HIGH] 20 Keystroke-map security-gated but plan partly autonomous — Plan 03 `autonomous:false` but 04/05 can proceed even if byte capture is provisional → wrong approve/deny bytes — fix: split keystroke capture into a blocking artifact with recorded per-backend byte sequences before any injection/lock integration passes.
- [HIGH] 20 Human-only guard applied too late — Plan 05 adds it after 03/04 already build working PTY injection → earlier code/tests can establish bypass patterns — fix: make the guard a dependency of permission injection + turn-lock gating, or enforce it in the shared `term.input` relay before Plan 03.
- [HIGH] 20 Callback data may exceed Telegram limits / collide — `po:<idx>:`+`requestId` assumes short id but transcript IDs may be UUIDs and Telegram callback data caps at 64 bytes — fix: store a short opaque callback token in the approvals registry; never put raw requestId in callback data.
- [HIGH] 20 Codex fallback trigger overbroad — "a line's schema is unrecognized" downgrades the whole adapter to terminal-byte scrape, hiding valid later entries — fix: skip+log unknown lines; enter scrape fallback only when session metadata can't resolve or core schema validation fails for the file/session.
- [HIGH] 20 Claude path mapping assumes session UUID == transcript filename — resolving `~/.claude/projects/<slug>/<session-uuid>.jsonl` from `(projectDir,sessionId)` may not hold; remo IDs ≠ Claude internal UUID — fix: Phase 16/17 must capture the actual Claude transcript/session id at PTY spawn and persist/pass it.
- [HIGH] 20 Codex `session_meta` mapping depends on a spawn-captured id not specified — Plan 01 requires matching `session_meta` id at spawn but Phase 20 files lack the runner/session metadata plumbing — fix: dependency/artifact from Phase 16/17 recording backend transcript identifiers per remo session, or include the plumbing in Plan 01.
- [MED] 20 `cliKind` source underspecified at the hub — "comes from runner session metadata the hub already tracks" may not exist reliably after the rip — fix: name the exact DAL/session field or supervisor registry API + test adapter selection from real metadata.
- [MED] 20 Transcript tail starts may replay old prompts — opening without a checkpoint reprocesses historical permission entries → stale approvals after reconnect — fix: per-session transcript cursor at spawn/subscribe; ignore entries before the live offset.
- [MED] 20 Queue overflow drops oldest silently — can discard a human turn vs terminal state or reorder intent — fix: reject newest with visible failure, or require confirmation before dropping queued turns.
- [MED] 20 Safety TTL can release into an active turn — releasing on missed `turn_complete` while CLI still processing interleaves the next writer — fix: TTL moves to blocked/manual-recovery unless a prompt-ready signal is observed; never auto-release into queued writes.
- [MED] 20 Permission detector duplicates adapter responsibility — adapters emit normalized permission entries while detector re-parses → two parse layers, unclear fail-closed ownership — fix: one normalizer (adapters emit raw candidates + detector owns normalization, OR adapters normalize + detector only validates policy).
- [MED] 20 Tests over-rely on fixtures for unstable transcript formats — may miss live drift — fix: require live capture artifacts for both backends + parser tests generated from captured samples.
- [MED] 20 Output-bridge finality undefined — `assistant_text` "final" but JSONL tailing may emit incremental/repeated entries → duplicate Telegram messages — fix: idempotency/finality fields in `TranscriptEntry` + duplicate/replay tests.
- [MED] 20 Old permission event source not explicitly removed — Plan 02 keeps `onPermissionPending` until 03, but 03 only greps `permission_response` in Telegram — fix: acceptance + grep that Telegram no longer subscribes to the deleted structured permission event source.
- [LOW] 20 Duplicate `20-PLAN-CHECK.md` content — authoritative-copy ambiguity — fix: single plan-check artifact.
- [LOW] 20 Validation command cwd inconsistent (`cd hub; bun test test/...` vs `bun test hub/test/...`) — fix: standardize cwd convention to match repo scripts.

---

## HIGH summary (phase → count)

- Phase 15: 6
- Phase 16: 7
- Phase 17: 8
- Phase 18: 9
- Phase 19: 10
- Phase 20: 11
- **Total HIGH: 51** (MED 49, LOW 14; 114 overall)

### Cross-phase HIGH themes (recurring, address once at the seam)
1. **Human-only guard / cost-cap is on the dispatch pipeline, but raw `term.input` is a separate relay path** that bypasses both (15, 16, 18, 19, 20). The guard + any turn-accounting MUST sit at the `term.input` relay boundary, not only in `dispatch/pipeline.ts`.
2. **Static grep canaries are insufficient** for the API-key / programmatic-flag / official-client invariants (15, 16, 17, 18, 19). Replace with behavioral spawn-interception tests asserting exact exe/argv/env (covering tmux builders, config merges, inherited `process.env`, and non-Anthropic provider keys).
3. **The one-way-door sequencing gate (Phase 17) is fakeable by a note file** (17) and downstream phases assume artifacts exist with only narrative dependencies (19, 20). Require machine-verifiable Phase 15/16 PASS artifacts + wave-0 dependency preflights.
4. **Session/transcript identity is unestablished** — PTY backend mode, Claude/Codex transcript ids, and per-session ownership are assumed but never persisted/plumbed (15, 16, 20). Capture + persist at PTY spawn in Phase 16/17.
5. **PLAN-CHECK vs VALIDATION metadata contradict** in every phase (`nyquist_compliant:false`/`wave_0_complete:false` while PLAN-CHECK says PASS) and each bundle contains a duplicate PLAN-CHECK — reconcile artifacts before execution.
