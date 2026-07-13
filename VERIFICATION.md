# VERIFICATION — PR #360 `fix/term-touch-scroll`

Independent QC verifier. Read-only inspection of the worktree vs `origin/main`, plus
independently executed per-file web tests and `bun run build:web`.

## VERDICT: **SHIP** (2 minor defects worth a follow-up, none blocking)

| Goal | Verdict |
|---|---|
| G1 — finger-drag scrolls the buffer | **PASS** |
| G2 — scrollback actually deeper | **PARTIAL** (correct + coherent, but the "needs a new signed installer" caveat covers BOTH supervisor files, not just the Rust one) |
| G3 — iOS keyboard no longer pops on every touch | **PASS** |

Invariants: all clean. No hard-fail.

---

## G1 — Finger-drag scrolls the buffer — **PASS**

- Drag drives xterm's own buffer API, not the broken DOM path.
  `web/src/components/TerminalSurface.tsx:279` → `term.scrollLines(-rows)`.
  The old `.xterm-viewport`.scrollTop poke is fully gone (diff removes `vpEl()`,
  `dragTop`); nothing in the file references `xterm-viewport` any more. ✅ "doesn't
  depend on the broken viewport.scrollTop path."
- **Direction sign is CORRECT.** `TerminalSurface.tsx:271-279`: `dy = y - lastY`
  (finger DOWN ⇒ `dy > 0`) → `accumPx += dy` → `rows = trunc(accumPx/px)` (positive)
  → `term.scrollLines(-rows)` (negative = scroll back / earlier output). Dragging the
  finger down reveals older output. Covered by `web/test/terminal-touch-scroll.test.tsx:114`
  (down ⇒ negative arg) and `:129` (up ⇒ positive).
- **Sub-row accumulation is real**, not truncated to zero: `accumPx -= rows * px`
  (`:277`) keeps the remainder across touchmove events, so repeated small drags
  eventually produce a row step. Test `:138` proves it.
- Row height derived from the laid-out grid (`rowPx()`, `:257-262`) with a 17px
  fallback — no xterm private API.
- `touchAction:'none'` on the host (`:471`) stops Safari stealing the gesture.

## G2 — Deeper scrollback — **PARTIAL**

The implementer's causal claim **checks out — verified independently**:

- Client clears on every (re)attach: `TerminalSurface.tsx:308` (`term.clear()` on
  mount/session switch) and again at `:332` inside the `term.reattach` handler
  ("clear then write the buffered scrollback"). After any reconnect the browser's
  xterm scrollback is **rewritten solely from the supervisor ring** — the ring IS the
  hard ceiling. Claim is true.
- Ring cap raised **coherently in both** halves, and they agree — no mismatch:
  - `supervisor/src/runners/pty-persistence.ts:45` → `1024 * 1024`
  - `supervisor/tauri/src-tauri/src/pty_host.rs:66` → `1024 * 1024`
- **Replay frame stays under the WS cap.** Hub `maxPayloadLength = 10 * 1024 * 1024`
  (`hub/src/index.ts:650`). 1 MiB raw → base64 ≈ 1.40 MB + JSON envelope. ~7x headroom.
- Web-side `scrollback: 5000 → 10000` (`TerminalSurface.tsx:166`) genuinely helps the
  live, un-reconnected session; xterm allocates lines lazily.

**Why PARTIAL:** the "needs a new signed MSI" caveat is *understated*. It is not just the
Rust file — `supervisor/src/runners/pty-persistence.ts` is `bun build --compile`d into the
sidecar shipped by the installer too. **Neither** supervisor-side depth change reaches the
user's installed host from a hub deploy; a hub deploy delivers only the web fixes (G1, G3,
and the 10k client-side scrollback). Say that plainly in the PR body so the owner doesn't
test depth on the current MSI and conclude the fix failed.

## G3 — iOS keyboard — **PASS**

- **Nothing focuses on touchstart.** `onTouchStart` (`:263-270`) records geometry only,
  with an explicit `// NOTE: deliberately NO focusTerm() here`. Test `:171` asserts it.
- **Tap focuses, drag does not.** `onTouchEnd` (`:284-293`): `isTap = maxMove <= 10px &&
  duration <= 500ms` → `focusTerm()`; else `e.preventDefault()`. Tests `:151` (drag ⇒ no
  focus) and `:161` (tap ⇒ focus).
- **Safari's synthetic mousedown after a drag cannot re-focus**: `preventDefault()` on the
  non-tap `touchend` (`:291`) suppresses the compat mouse-event replay; `touchmove` is also
  preventDefault'd throughout, which independently suppresses it.
- **Desktop click-to-focus intact**: `host.addEventListener('mousedown', focusTerm)`
  (`:302`), unchanged, cleaned up on unmount (`:382`).
- **Dismiss affordance exists**: `⌨` toggle (`:444-453`) → `toggleKeyboard` (`:106-116`)
  blurs `term.textarea` when open, focuses when closed. Test `:179`.

## Invariants — all checked

| Invariant | Result | Evidence |
|---|---|---|
| 1:1 `term.onData` → exactly ONE `term.input`; no second writer | **OK** | `TerminalSurface.tsx:316-319` — single `onData` disposable, one `send({type:'term.input'})`, generation-guarded. Untouched by this PR. `web/test/pty-single-writer.test.tsx` 2/2 pass. |
| Scrolling emits ZERO `term.input` frames | **OK** | No `send()` anywhere in the touch handlers; only `term.scrollLines`. Tests `:189` (alt-screen) and `:205` (normal buffer) assert zero `term.input`. |
| No `compositionstart/end` gate on `onData` | **OK** | Absent; the #306/#307 warning comment survives at `:204-210`. |
| No provider API key / stream-json on PTY path | **OK** | PR touches no spawn/argv/env code. `web/test/cutover-deletion-gate.test.ts` 8/8 pass. |
| No indigo accent | **OK** | `web/test/no-indigo.test.ts` 1/1 pass. |
| Typing still works after tap-to-focus | **OK** | `focusTerm` → `term.focus()` (`:216`) — same call desktop mousedown uses, focuses xterm's hidden textarea. Test `:161`. |
| Alt-screen: no keystroke injection to fake scrolling | **OK** | `isAltScreen()` (`:254`) short-circuits the scroll math; a drag in a TUI is a deliberate no-op. |

## Defects / gaps (non-blocking)

1. **Side effects inside a `setState` updater** — `TerminalSurface.tsx:107-115`:
   `setKbOpen((open) => { ...term.focus()/blur()...; return !open })`. Impure updater;
   under React StrictMode (dev) updaters double-invoke, so focus/blur fires twice per
   click. Idempotent today, but it's a trap — the effect belongs outside the updater.
2. **Touch-dragging the native scrollbar thumb now inverts.** `touchmove` preventDefaults
   unconditionally (`:281`), so a touch that starts on xterm's thin scrollbar is also
   routed through the finger-follows-content mapping. Thumb-down used to scroll toward
   newer output; it now scrolls toward older. Cosmetic (the whole surface is draggable
   now), but real.
3. **`touchAction:'none'` disables pinch-zoom / double-tap zoom over the terminal** — the
   browser zoom escape hatch is gone on the largest surface. Conscious-accept item.
4. **Multi-touch/pinch unhandled and untested** — the handler always reads `e.touches[0]`,
   so a two-finger gesture is treated as a one-finger scroll.
5. **`touchcancel` not handled** — harmless: `touchstart` resets `maxMove`/`accumPx`/timers,
   so no stale state survives an interrupted gesture.
6. **Drag-then-tap sequence untested** — logically fine (all counters reset in
   `onTouchStart`, `:263-270`), but nothing pins it.
7. **`kbOpen` can drift from reality** — toolbar buttons refocus via `sendKey`, iOS can
   dismiss the keyboard on its own, neither updates the flag. Worst case: one extra press
   of ⌨.
8. **Ring truncation is byte-exact, not escape-aware** (pre-existing, both halves): a
   snapshot can begin mid-ANSI-sequence, garbling the first replayed line. Not introduced
   here; a larger ring makes it proportionally less visible.
9. **Memory**: 1 MiB ring per live PTY session in the Rust host (+1 MiB in the TS ring on
   the Node path). 12 grid sessions ⇒ ~12–24 MB. Bounded, acceptable.
10. **`term.clear()`-on-reattach wipes nothing the user needs** beyond what the ring
    restores — the transcript is on disk / resume-by-`project_dir`; the browser buffer is a
    cache. Confirmed at `:308` and `:329-334`.
11. **visualViewport resize handling intact** — `vv.addEventListener('resize', sendResize)`
    (`:366-367`) and its removal (`:379`) are unchanged by this PR.

## Evidence actually observed

Per-file isolated web tests (repo QC mode), run from this worktree:

```
web/test/cutover-deletion-gate.test.ts     ::  8 pass  0 fail
web/test/no-indigo.test.ts                 ::  1 pass  0 fail
web/test/repo-groups.test.ts               :: 11 pass  0 fail
web/test/session-action-button.test.ts     ::  5 pass  0 fail
web/test/session-list.test.ts              :: 11 pass  0 fail
web/test/tasks-redesign.test.ts            :: 10 pass  0 fail
web/test/terminal-byte-encoding.test.ts    ::  4 pass  0 fail
web/test/terminal-keybar.test.ts           ::  3 pass  0 fail
web/test/use-sessions-disconnect.test.ts   ::  4 pass  0 fail
web/test/auto-dev-activity.test.tsx        ::  6 pass  0 fail
web/test/pty-single-writer.test.tsx        ::  2 pass  0 fail
web/test/terminal-surface.test.tsx         ::  6 pass  0 fail
web/test/terminal-touch-scroll.test.tsx    ::  9 pass  0 fail   (new)
web/test/usage-dual-bucket.test.tsx        ::  9 pass  0 fail
```

**89 pass / 0 fail across 14 files.**

`bun run build:web` → `✓ built in 2.75s`, `dist/assets/index-Bv_y9MZt.js 1,110.35 kB`
(only the pre-existing >500 kB chunk-size warning). No type/build errors.
