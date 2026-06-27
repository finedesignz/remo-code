# 15-03 SUMMARY — xterm panel + compile-derisk (Plan 03)

**Status:** Tasks 1–2 COMPLETE. **Task 3 = OPERATOR CHECKPOINT (autonomous:false) — build-script change NOT committed pending decision.**

## Built (Tasks 1–2)
- `web/package.json` — `@xterm/xterm ^6.0.0` + `@xterm/addon-fit ^0.11.0` (installed via npm; Bun cache
  move EPERMs on this host).
- `web/src/components/TerminalSurface.tsx` — themed xterm.js panel: writes incoming `term.data`, sends
  `term.input` on keystroke, `fit()` + `term.resize` on resize, `term.attach` on mount. Theme from
  `--bg-primary`/`--text-primary`/`--accent-blue` (BLUE accent; no forbidden purple-blue). Isolated to the
  `term.*` channel; never touches chat message path.
- `web/src/components/ChatLayout.tsx` — additive branch: when `localStorage['remo:pty-interactive']==='1'`
  and a session is active, render `<TerminalSurface>` instead of `<ChatPanel>`. Non-PTY sessions unchanged
  (ChatSurface deletion is Phase 17). App chrome untouched.

## QC
- `web/test/no-indigo.test.ts` GREEN. `bun run build` (tsc -b && vite build) GREEN — xterm bundles.

## Task 3 — compile-shipping derisk (R-PTY-04) → CHECKPOINT
The PTY derisk is empirically COMPLETE (see `15-SPIKE-FINDINGS.md §1`): node-pty works under Node, NOT
under Bun-on-Windows; the Bun sidecar spawns a Node `pty-host.mjs` (approach b), proven end-to-end.

The remaining decision is **how the Node runtime + node-pty ship in the MSI** — this materially changes
packaging, so it is an operator checkpoint. Options + recommendation in `15-SPIKE-FINDINGS.md §3`:
- **A (recommended):** bundle portable `node.exe` + prebuilt `node-pty` + `pty-host.mjs` as Tauri
  `resources`; sidecar resolves bundled `node.exe`. Smallest delta from the proven spike; no native
  compile; +~30–50 MB MSI.
- B: compile a standalone `pty-host.exe` (SEA/pkg) as a 2nd externalBin.
- C: reimplement the PTY host in Rust in the Tauri shell (largest rewrite).

`build-and-update.ps1` / `tauri.conf.json` / the sidecar's `node` path resolution are **NOT changed** —
awaiting the operator's pick. Once chosen, Phase 16 wires it + exercises a PTY turn through the built MSI.
