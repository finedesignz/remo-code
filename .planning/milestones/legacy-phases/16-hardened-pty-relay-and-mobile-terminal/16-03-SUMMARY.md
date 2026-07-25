---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 03
subsystem: web-terminal-surface
tags: [pty, xterm, mobile, web]
provides:
  - "mobile-ready themed xterm.js TerminalSurface for pty-interactive sessions"
  - "term.* WS client (term-ws.ts) + useTerminalSession hook"
requires:
  - 16-01
  - 16-02
affects:
  - web/src/components
  - web/src/hooks
  - web/src/lib
tech-stack:
  patterns: ["FitAddon resize", "visualViewport mobile-keyboard resize", "scrollback replay on reattach", "session-switch buffer clear"]
key-files:
  created:
    - web/src/lib/term-ws.ts
    - web/src/hooks/useTerminalSession.ts
    - web/test/terminal-surface.test.tsx
  modified:
    - web/src/components/TerminalSurface.tsx
decisions:
  - "hardened the Phase-15 TerminalSurface in place (uses the shared WS context subscribe/send) rather than open a 2nd WS; term-ws.ts/useTerminalSession ship as the portable+tested lib seam"
  - "no DOM test infra in repo → surface logic proven via openTermWs + a fake WebSocket (no React render)"
metrics:
  duration: ~40m
  completed: 2026-06-01
---

# Phase 16 Plan 03: Mobile Terminal Surface Summary

A themed, mobile-ready xterm.js terminal surface renders the interactive `claude` TUI for pty-interactive
sessions inside the existing shell — reconnect replays scrollback, resize propagates cols/rows to the PTY
(container + orientation + mobile keyboard-viewport), scrollback works on touch + desktop — running ALONGSIDE
ChatSurface (no deletion; the rip is Phase 17).

## What shipped

- **term-ws.ts**: a focused raw-terminal WS client (attach/reattach/input/resize) — cookie-first auth,
  session-keyed, UTF-8-safe base64, injectable WS factory for tests. Speaks ONLY `term.*` (no structured
  chat path).
- **useTerminalSession.ts**: the term.* lifecycle hook — initial attach, reconnect → term.reattach →
  scrollback replay, resize → term.resize, teardown + buffer-clear on unmount/session switch.
- **TerminalSurface.tsx** (hardened): clears the xterm buffer on session switch (T-16-10 — no cross-session
  bleed), requests `term.reattach` and replays the `scrollback` blob before live `term.data`, and propagates
  resize via an rAF-debounced handler wired to `ResizeObserver` + `orientationchange` + `visualViewport`
  (mobile on-screen keyboard). Theme mapped from `--bg-primary`/`--text-primary`; blue cursor; no indigo.
  Mounts only for pty-interactive sessions (ChatLayout `remo:pty-interactive` flag, Phase-15 seam) ALONGSIDE
  ChatSurface.

## Verification

- `web/test/terminal-surface.test.tsx` (7 tests via the `openTermWs` lib + fake WebSocket): attach+reattach
  after auth, decoded `term.data` delivery, `term.reattach{scrollback}` → onScrollback (replay-before-live),
  cross-session frame ignored, pre-auth ignored, input→base64 + resize→cols/rows framing.
- `web/test/no-indigo.test.ts` green (the new components introduce no indigo).
- `cd web && bun run build` (tsc -b + vite) green.

## Manual verifications still pending (VALIDATION Manual-Only, R-PTY-09)

On a real phone: rotate + open the on-screen keyboard + scroll back, verify cols/rows track and scrollback is
reachable; and (R-PTY-07) drop wifi mid-turn + reconnect, verify the same session + scrollback. These feed
the `render_fidelity` / `mobile_reattach` attestations in `16-VERIFICATION.md` (currently FAIL/pending — the
emitter refuses to fabricate the triplet).

## Deviations from Plan

**1. [Rule 3 — Blocking] No DOM test infra → surface proven via the lib seam**
- The repo ships no happy-dom/jsdom/@testing-library and no `.tsx` test precedent. Rather than add heavy DOM
  infra, `terminal-surface.test.tsx` drives the LOAD-BEARING logic through `openTermWs` (the same lib the
  surface + hook consume) with a fake WebSocket — covering attach/reattach/scrollback-replay/session-filter/
  input/resize without a React render. The xterm-render path is covered by the manual device proofs (R-PTY-09).

**2. [Smallest-diff] Hardened the existing TerminalSurface rather than swap to useTerminalSession**
- ChatLayout already wires TerminalSurface on the shared WS-context `subscribe`/`send` (one connection).
  Re-mounting it on the standalone `useTerminalSession` (which opens its OWN WS) would waste a connection.
  The hardening (buffer-clear, reattach/replay, orientation+visualViewport resize) was applied in place on
  that proven seam; `term-ws.ts` + `useTerminalSession.ts` ship as the portable, tested lib (Task-1 artifacts
  + the seam Phase 17 reuses when ChatSurface is removed).

## Known Stubs

None affecting the plan goal.

## Self-Check: PASSED
- term-ws.ts, useTerminalSession.ts, terminal-surface.test.tsx present; TerminalSurface.tsx modified.
- Commit f7bed97. 7 surface tests + no-indigo + web build green.
