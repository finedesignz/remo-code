# remo-code-supervisor (runtime)

This directory is the **runtime** for the supervisor. It is NOT a stand-alone
CLI — it ships exclusively as the sidecar inside the Remo Code tray app at
[`supervisor/tauri/`](./tauri/).

For end users: download the Windows .msi from
**[GitHub Releases](https://github.com/finedesignz/remo-code/releases/latest)**.
The tray app handles install, auto-start, configuration, and lifecycle.

For history on the migration from the old `npx remo-code-supervisor install`
NSSM-backed CLI to the tray app, see [`MIGRATION.md`](./MIGRATION.md).

## What's in here

| File | Purpose |
| --- | --- |
| `src/index.ts` | Foreground supervisor entrypoint. Subcommands: `run` (used by Tauri sidecar), `scan` (diagnostic). |
| `src/hub-client.ts` | WS client that connects to the Remo Code hub. |
| `src/process-manager.ts` | Spawns `claude` per session, enforces sandbox/concurrency caps. |
| `src/sandbox.ts` | Allowed-folders + git-only gates. |
| `src/audit.ts` | Append-only JSONL audit log. |
| `src/repo-scanner.ts` | Discovers git repos under configured roots. |
| `src/commands/` | Built-in supervisor commands (run, kill, status, etc.). |
| `src/commands-scanner.ts` | Discovers user/plugin slash-commands. |
| `src/git-ops.ts` | Git-ops helpers used by Coolify self-heal companion. |
| `src/watchdog.ts` | Self-heal watchdog for spawned claude processes. |
| `src/config.ts` | Reads/writes `%APPDATA%\remo-code\supervisor.json`. |
| `test/` | Bun test suite. |

## Running directly (developer inner-loop)

The Tauri tray app spawns this with `bun src/index.ts run`. If you want to run
the runtime directly while developing the tray app (or against a hand-written
config file), the same command works:

```powershell
bun src/index.ts run
```

`bun src/index.ts scan` prints the list of git repos discovered under the
configured `roots` and exits — useful for sanity-checking sandbox config.

## Config

`%APPDATA%\remo-code\supervisor.json` (Windows). The tray app writes this for
you via its first-run wizard.

```json
{
  "api_key": "olx_xxx",
  "hub_url": "https://app.remo-code.com",
  "roots": ["C:\\Users\\you\\GitHub"],
  "max_concurrent": 1
}
```

## Logs

`%LOCALAPPDATA%\remo-code-supervisor\supervisor.log` (rotates at 5 MB → `supervisor.log.1`).

## License

MIT
