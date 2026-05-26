# Supervisor Distribution Migration — NSSM/npm → Tauri Tray App

**Date:** 2026-05-26
**Status:** In-progress (this PR retires the install path; release engineering is a separate concern).

## TL;DR

The Bun supervisor is no longer distributed as a stand-alone npm CLI installed via
`npx remo-code-supervisor install` + NSSM. The Windows tray app from PR #21
(`supervisor/tauri/`) is now the **sole** distribution channel. It bundles the
existing Bun supervisor as a managed sidecar.

## Architecture decision — A (chosen) vs B

We considered two ways to retire the old install harness:

| Option | Description | Diff size | Tauri impact |
|---|---|---|---|
| **A (chosen)** | Keep `supervisor/src/` as-is (runtime library). Delete only the install harness (`install`/`uninstall` subcommands, `nssm-installer.ts`, npm publish workflow, `bin` field). The Tauri sidecar continues to spawn `bun src/index.ts run` from the same `supervisor/` package dir. | Small — surgical deletions only. | Zero — `supervisor/tauri/src-tauri/src/sidecar.rs::spawn_child` already does exactly `bun src/index.ts run` against `CARGO_MANIFEST_DIR/../../supervisor`. |
| B (rejected) | Fold `supervisor/src/` into `supervisor/tauri/src-tauri/resources/supervisor/`. One directory. | Large — rewrite of every import path; new bundling layout. | High — `sidecar.rs::resolve_supervisor_dir` and the MSI `externalBin`/resource wiring both have to change in lockstep. |

**Rationale for A:**

1. **Tauri sidecar contract is already stable.** `sidecar.rs` spawns
   `bun src/index.ts run` against the existing `supervisor/` dir. B would force a
   simultaneous rewrite of the runtime layout AND the tray-app resource bundling
   — two coupled changes is more risk than one surgical deletion.
2. **Workspace layout stays orthogonal.** `supervisor/` is the runtime; `supervisor/tauri/` is the desktop shell. Collapsing them couples runtime evolution to tray-app
   release cadence. The runtime is touched by Phase 04 (claude-usage threshold) and
   Phase 06 (self-heal absorb) on a much faster cadence than the tray app is
   re-released.
3. **Sidecar bundling (`externalBin`) for the MSI is a separate concern** — see
   PLAN-006-installer-and-autostart §"Ship the Bun sidecar binary inside the MSI".
   That work is queued; this PR does not preempt it. The Tauri sidecar in dev mode
   continues to work against the on-disk `supervisor/src/`, so the developer
   inner-loop is unchanged.
4. **Reversibility.** If we ever want to re-publish the Bun supervisor for
   headless server installs, restoring the `bin` field + an `install` subcommand
   is a trivial follow-up. Option B would have to be unwound atomically.

## What's deleted

- `supervisor/src/nssm-installer.ts` — entire file. NSSM is gone.
- `supervisor/src/index.ts`: the `install`, `uninstall`, and `status` subcommands. The `run` and `scan` subcommands stay.
- `supervisor/package.json`: the `bin` field (no longer an npm CLI).
- `.github/workflows/publish-supervisor.yml` — npm publishing workflow.
- Install-instruction copy in `web/src/components/{ConnectModal,SetupForm,SettingsPage,ApiKeyModal,SupervisorPage,CommandsList}.tsx` — replaced with a link to the tray-app MSI on GitHub Releases.
- `docs/HANDOFF.md` NSSM section + the `nssm`/`npx remo-code-supervisor install` references in `README.md`, `CLAUDE.md`.

## What's preserved

- The entire **runtime** of the Bun supervisor (`supervisor/src/{hub-client,process-manager,sandbox,audit,git-ops,builtins,commands,commands-scanner,repo-scanner,watchdog,config}.ts`) — the Tauri tray app spawns this verbatim.
- The `run` subcommand (used by the Tauri sidecar) and the `scan` subcommand (kept for diagnostics).
- `.github/workflows/release-supervisor.yml` — the Tauri MSI release workflow.
- `supervisor/tauri/` in its entirety.
- Existing `supervisor.json` config layout (so an upgrading user's settings carry across).
- File-logging behavior in `index.ts run` (the Tauri sidecar consumes the logs).

## Out of scope (release engineering — separate concern)

- Building and shipping the first signed/unsigned MSI for the tray app — release engineering. The Tauri sidecar bundling work in PLAN-006 §"externalBin" is not done in this PR; the dev inner-loop still works because `sidecar.rs::resolve_supervisor_dir` falls back to `CARGO_MANIFEST_DIR/../..`.
- Coolify-dev-supervisor headless server use case (Phase 04) — was always documented as a future concern; if/when it ships, it will use a different distribution mechanism (likely a long-running docker container or a direct Bun install — not NSSM).
- Deprecating the existing `remo-code-supervisor@0.1.0` / `@0.3.1` versions on npm. Suggested follow-up: `npm deprecate remo-code-supervisor "Use the Remo Code tray app at https://github.com/finedesignz/remo-code/releases instead"`. npm does not allow full unpublish of versions older than 72h.

## User-action required after this lands

1. **Publish the first tray-app MSI release.** Until the MSI is on GitHub Releases, the "Download Remo Code tray app" link in the UI 404s. Until then, the link points to `https://github.com/finedesignz/remo-code/releases/latest` and the UI notes "the .msi is coming".
2. (Optional) Run `npm deprecate remo-code-supervisor@'<0.4.0' "Use the Remo Code tray app instead"` to mark the historical npm versions as deprecated.
