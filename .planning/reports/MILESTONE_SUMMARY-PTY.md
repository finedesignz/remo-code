# Milestone Summary: m-interactive-pty-runner (Phases 15-20)

Status: SHIPPED. PROJECT.md dates it 2026-06-04; merge dates in PR history run 2026-06-01 to 2026-06-05 (cutover PRs #244-#246 merged 2026-06-05). Artifacts thin: no milestone directory; summarized from PROJECT.md, CLAUDE.md and PR history.

## 1. Overview

Make the interactive `claude`/`codex` TUI over a Rust ConPTY the default human surface (web + phone), replacing the stream-json ChatSurface for humans, with no API key on that path.

## 2. Architecture

Supervisor Rust `pty_host.rs` (ConPTY) <-> Bun sidecar `ClaudePtyBridge` <-> hub `/ws/client` `term.*` frames <-> web `TerminalSurface`. Hub flag `REMO_PTY_INTERACTIVE` drives `GET /api/client-config` `pty_interactive`. Spawn env goes through `env-sanitize.ts`; argv is an allowlist of one.

## 3. Phases

Phase numbers 15-20 come from STATE/PROJECT; per-phase artifacts are not present. Key PRs:

| PR | Date | Change |
|----|------|--------|
| #235 | 2026-06-01 | PTY infra landed dark behind `REMO_PTY_INTERACTIVE` |
| #244 | 2026-06-05 | Rust ConPTY wired onto live human path (cutover A) |
| #245 | 2026-06-05 | Web defaults to TerminalSurface (cutover B) |
| #246 | 2026-06-05 | Supervisor v0.9.0 |
| #247 | 2026-06-05 | Telegram transcript-tail decoupled from PTY flag |
| #248 | 2026-06-05 | Cutover docs |
| #250, #261, #263 | 2026-06-05 | Raw byte relay, write-lock release, master-writer-once-at-spawn fixes |
| #264, #265 | 2026-06-05 | Key bar + file attachments; supervisor v0.10.0 |
| #282, #283 | 2026-06-14 | June-15 billing runbook; skip-permissions on PTY (v0.11.0) |

## 4. Decisions

- No provider API key on the human PTY path, ever; fallback is a backend-CLI swap (Codex), never the API (CLAUDE.md invariant).
- Fail-safe backend selector defaults to `codex-pty` until the June-15 cutover gate confirms interactive billing (CLAUDE.md; later operator-overridden to Claude-PTY per CLAUDE.md text).
- Telegram transcript tail kept OFF in Coolify.

## 5. Requirements

No REQUIREMENTS file. Inferred scope from CLAUDE.md: universal PTY human path, dual-bucket usage, backend selector, cutover gate.

## 6. Tech Debt

- ChatSurface deletion gated on device attestations (`docs/cutover-gate-june15.md`).
- Later PTY terminal defects (doubled keystrokes #317/#354, IME #470/#473, scrollback #460-#474) show hardening continued after ship.

## 7. Getting Started

Read `docs/usage-cost.md` (PTY sections), `docs/cutover-gate-june15.md`, `supervisor/src/runners/`. Guard test: `supervisor/test/no-api-key-no-streamjson-pty.test.ts`.
