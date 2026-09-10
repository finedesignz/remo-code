# Phase 15 — SPIKE-FINDINGS (node-pty under Bun on Windows + compile-shipping contract)

**Measured:** 2026-05-31 · Host: Windows 11 Pro 10.0.26200, x64 · Bun 1.3.14 · Node v22.16.0 · claude 2.1.159
**Status:** PTY derisk COMPLETE. Compile-shipping decision = **OPERATOR CHECKPOINT (Plan 03 T3, autonomous:false)** — RESOLVED 2026-05-31 (see §6).

This doc is the authoritative Phase-16 shipping contract. Read it before productionizing the PTY runner.

---

## 1. Verdict: node-pty under Bun on Windows = **WORKS-WITH-helper-exe (approach b)**

| Runtime | `require('node-pty')` loads? | PTY spawn + byte I/O? |
|---|---|---|
| **Node v22** (win32-x64) | ✅ yes | ✅ yes — full ConPTY, bytes stream, echo + interactive `claude` TUI render |
| **Bun 1.3.14** (win32-x64) | ✅ yes (addon loads) | ❌ **NO** — first PTY write throws `ERR_SOCKET_CLOSED` inside `windowsTerminal.js` |

**Root cause:** node-pty's Windows backend (both ConPTY and the winpty fallback) drives its terminal
I/O over `node:net` **named-pipe Sockets**. Bun-on-Windows does not fully implement those named-pipe
sockets, so the socket closes on first write. This is a **Bun runtime limitation, not a binary/ABI
problem** — the IDENTICAL prebuilt `pty.node` / `conpty.node` works perfectly under Node. `useConpty:true`
does not help (the failure is in the socket layer above the backend choice).

**Therefore:** the Bun sidecar CANNOT host the PTY in-process. It must delegate to a Node process.

### What was empirically proven (all on this host)
1. `bun add node-pty` records the dep but the Bun package cache move hits `EPERM` on this host
   (antivirus/file-lock). `npm install node-pty` installs cleanly and places the prebuilt binaries.
2. **node-pty 1.1.0 ships Windows ConPTY prebuilds via npm** — `prebuilds/win32-x64/{conpty.node,
   pty.node, conpty_console_list.node}` (+ winpty fallback). **No `node-gyp` compile needed** on Windows
   x64. (The `@homebridge/...-prebuilt-multiarch` fork's npm tarball only carried linux prebuilds and fell
   back to a failing `node-gyp rebuild` — upstream `node-pty` is the better choice here.)
3. Under **Node**: `pty.spawn('cmd.exe', ...)` streams bytes, echo round-trips (377–448 bytes).
4. Under **Node**: `pty.spawn('claude', [], {env w/ ANTHROPIC_API_KEY deleted})` renders the GENUINE
   interactive `claude` TUI — captured 1047 bytes incl. the real trust prompt
   *"Accessing workspace: C:\Users\artic … Quick safety check: Is this a project you created or one you
   trust?"* — with NO `-p`, NO stream-json flags, NO API key.
5. **Bun parent → Node `pty-host.mjs` child over a length-prefixed JSON-frame stdio protocol → ConPTY →
   cmd.exe**: echo round-trips end-to-end (448 bytes, marker seen). **Approach (b) works under Bun.**

---

## 2. The shipped architecture (this spike, the seed for Phase 16)

```
Bun sidecar (compiled exe)                 Node PTY host (pty-host.mjs)
  ClaudePtyRunner  ── spawn('node',[host]) ──►  require('node-pty')
   write/resize/kill ── stdio frames ───────►   pty.spawn('claude',[],{env-ANTHROPIC_API_KEY})
   onData ◄────────── {t:'data',d} frames ──    ConPTY ◄─► interactive claude TUI
```

- **`supervisor/src/runners/claude-pty-runner.ts`** — runs in the Bun sidecar. Raw-bytes-only. Spawns the
  host via an injectable `ptySpawn`/host-spawn seam (test-interceptable). Strips `ANTHROPIC_API_KEY`,
  sends `claude` with EMPTY argv. No RunnerEvent / agent-protocol / session-bridge / credentials coupling.
- **`supervisor/src/runners/pty-host.mjs`** — runs under Node. Hosts node-pty/ConPTY, strips
  `ANTHROPIC_API_KEY` again (defense in depth), dead-man's-switch (stdin-end + 1s parent-PID poll) so no
  orphan `claude`/host survives a crashed supervisor.
- Frame protocol: 4-byte big-endian length prefix + UTF-8 JSON. parent→host `spawn/input/resize/kill`;
  host→parent `spawned/data/exit/error`.

---

## 3. THE COMPILE-SHIPPING DECISION — operator checkpoint (R-PTY-04)

`bun build --compile` produces a single Bun exe and **cannot embed a `.node` addon** (confirmed by the
Bun docs + the runtime failure above). Because the PTY host must run under **Node** (not Bun), the spike's
helper-process model already solves the "addon can't be in the Bun blob" problem — but it introduces a
**new packaging question: where does the Node runtime + node-pty come from on the user's machine?**

The compiled sidecar today does `spawn('node', [pty-host.mjs])`. That assumes a Node on PATH, which we
CANNOT assume on an end-user Windows box. The three credible options:

### Option A — ship a Node runtime + node-pty beside the sidecar (RECOMMENDED)
- Bundle a pinned, portable `node.exe` (or the official Node Windows zip's `node.exe`) + the `node-pty`
  package (JS + `prebuilds/win32-x64/*.node`) + `pty-host.mjs` as **Tauri `resources`** next to the
  sidecar exe.
- `ClaudePtyRunner` resolves the bundled `node.exe` and host script via a path relative to the executable
  (Tauri resource dir), NOT the PATH `node`.
- **Pros:** simplest mental model; node-pty needs no compile (prebuilt); the Node↔node-pty pairing is the
  proven-working combination; one MSI. **Cons:** MSI grows ~30–50 MB (Node runtime); must pin Node major
  to the prebuild's N-API range.

### Option B — compile the PTY host itself into a tiny standalone helper exe
- `pkg`/`node --experimental-sea`/nexe the `pty-host.mjs` + node-pty into `pty-host.exe`, ship that one
  binary as a second Tauri `externalBin` sidecar; the Bun sidecar spawns it.
- **Pros:** no loose `node_modules`; a single extra exe. **Cons:** SEA + native-addon bundling is fiddly
  (the `.node` still rides outside the SEA blob → back to "ship the .node beside it"); more build-pipeline
  surface than A for little gain.

### Option C — Tauri Rust shell hosts the PTY out-of-band
- Use a Rust PTY crate (`portable-pty`/`conpty`) in the Tauri shell; the Bun sidecar connects over a
  localhost socket / the existing Tauri IPC.
- **Pros:** no Node runtime shipped; ConPTY via Rust is robust; smallest binary. **Cons:** largest rewrite
  (reimplements the host in Rust, diverges from the Node `pty-host.mjs` seed this spike proved); loses the
  single-language supervisor; bigger Phase-16 scope.

### RECOMMENDATION → **Option A** (ship portable Node + prebuilt node-pty as Tauri resources)
It is the smallest delta from the proven spike (the Node host is already written and working), needs zero
native compilation (node-pty prebuilds), and keeps the supervisor in TS/JS. The only real cost is MSI
size, which is acceptable for a desktop tray app. Pin Node to a major whose N-API matches node-pty 1.1.0's
prebuild (Node 20/22 LTS verified working here on 22).

**Build-script change required (deferred to the checkpoint decision):** `supervisor/tauri/scripts/
build-and-update.ps1` + `tauri.conf.json` `bundle.resources` would stage `node.exe` + `node_modules/
node-pty` + `pty-host.mjs` next to `binaries/remo-code-supervisor-*.exe`, and `claude-pty-runner.ts` would
resolve the bundled `node.exe` instead of PATH `node`. **NOT committed** pending operator approval (this
materially changes MSI packaging — `autonomous:false`).

> **NOTE (2026-05-31): the operator overrode this recommendation — see §6.** Option C (Rust ConPTY) is the
> adopted TARGET, with Option A demoted to the proven fallback. The §3 recommendation is retained as the
> as-written spike output for the audit trail.

---

## 4. What Phase 16 inherits / depends on

- The spawn contract (file `claude`, empty argv, `ANTHROPIC_API_KEY` deleted) is locked by the behavioral
  interception harness + grep canary. Phase 16 MUST keep both green.
- The Node-helper-host model is the shipping reality on Windows. Phase 16 productionizes: bundled-Node
  resolution (Option A), tmux/persistence + reattach (POSIX) / ConPTY session persistence, resize debounce,
  scrollback, the **detach-vs-kill policy** (client-disconnect DETACHES; session-close/idle-reap/
  supervisor-exit KILLS — the spike's connection-scoped kill is the pre-persistence baseline).
- POSIX supervisors (Linux/Coolify) likely run node-pty under Bun's forkpty path — **NOT yet tested**;
  Phase 16 must verify whether the Node-host detour is also required on Linux or only on Windows.
- The raw-terminal WS channel (`term.*`, base64) is isolated from agent-protocol and tested. Phase 16
  hardens auth scoping + binary frames.

## 5. Open items explicitly NOT done in the spike
- Bundled-Node packaging + build-script change (operator checkpoint above).
- A PTY turn exercised THROUGH a fully-built MSI sidecar (blocked on the packaging decision — the
  end-to-end Bun-parent→Node-host→ConPTY→claude path IS proven from `bun run`/compiled-context source).
- Linux/forkpty-under-Bun verification.

---

## 6. Operator checkpoint RESOLVED (2026-05-31)

> **Operator decision (2026-05-31): Option C — Rust ConPTY — adopted as the TARGET end-state**, BUT gated. The spike proved *Node* ConPTY (not Rust), so Phase 16 MUST OPEN with a short Rust-ConPTY derisk spike that mirrors the Node proof: spawn the genuine interactive `claude` TUI from the Tauri Rust side (e.g. wezterm `portable-pty` or a `conpty` crate), capture the real trust prompt, confirm byte relay round-trips, with ANTHROPIC_API_KEY deleted and NO -p/stream-json flags. **Fallback = Option A** (bundle pinned portable node.exe + prebuilt node-pty + pty-host.mjs as Tauri resources — already fully proven) if the Rust spike cannot render the real interactive TUI. Rationale: smallest footprint / no JS-runtime bundle is the better end-state and matches operator preference, but the milestone must not bet on an unproven runtime — derisk-first, proven-fallback.

**Packaging intentionally NOT changed in Phase 15:** `supervisor/tauri/scripts/build-and-update.ps1`,
`tauri.conf.json` (`bundle.resources`), and the sidecar's `node`-path resolution in
`claude-pty-runner.ts` were deliberately left untouched in Phase 15 — the Rust ConPTY path (Option C) may
make Option-A Node bundling unnecessary entirely; the Phase 16 opening spike decides which packaging delta
(if any) lands.
