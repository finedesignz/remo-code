# Supervisor in a Claude Code cloud session

Run a headless Remo supervisor inside a Claude Code cloud session
(claude.ai/code) so the session's repos show up as a Remo host. No Tauri, no
tray: the Bun source runs directly on the container's Linux.

## How it works

- `tools/cloud-session/setup.sh` runs as the cloud environment's **Setup
  script** at session start. It shallow-clones this (public) repo to
  `~/.remo-code`, installs the supervisor deps (node-pty builds from source on
  linux), writes `~/.config/remo-code/supervisor.json` from env vars, registers
  a user-level `SessionStart` hook, and starts the supervisor.
- `tools/cloud-session/start.sh` is the idempotent launcher (pidfile under
  `~/.local/state/remo-code-supervisor/`). The `SessionStart` hook re-runs it on
  every session start/resume, because the container can be reclaimed while
  idle. The supervisor is only online while the cloud session's container is.
- **Claude login:** the spawned `claude` inherits the cloud session's own login.
  It still authenticates after `sanitizeSpawnEnv` scrubs the env (verified in a
  cloud container), so no API key or setup-token is involved.
- **Terminal surface:** with no Rust ConPTY host, `runner-factory.ts` falls back
  to the Node `pty-host.mjs` + node-pty path automatically.
- **Network:** a cloud session reaches the internet only through `HTTPS_PROXY`.
  Bun's `WebSocket` needs the proxy passed explicitly, so hub sockets are opened
  via `supervisor/src/ws-proxy.ts` (`openHubWebSocket`), which honours
  `HTTPS_PROXY`/`NO_PROXY`. With no proxy env set it is a plain `new WebSocket`.

## Host keys (`purpose='host'`)

The hub allows ONE active `purpose='supervisor'` key per user, and minting a new
agent key used to revoke it and hot-swap it into every connected supervisor.
Two hosts sharing a key evict each other (`registerSupervisor` closes the older
socket `4003 replaced`). So a second host gets its own key:

- `POST /api/api-keys { scopes: ['agent'], host: true }` → `purpose='host'`.
  N per user; never revokes the tray app's key; `host` without `agent` → 400.
- Key hot-swap (`pushKeyRotatedToUser`) is now targeted with `onlyApiKeyIds`:
  a new supervisor key reaches only the socket on the prior supervisor key;
  rotating any key reaches only the host that held it.
- Web: Settings → Credentials → Create key → tick `agent` → tick
  **Additional host**.

## Setup

1. Web: create an **Additional host** key (above).
2. Cloud environment settings (session title bar → environment → Edit):
   - **Network access:** Full (or a custom allowlist containing
     `app.remo-code.com`). Applies to NEW sessions only.
   - **Environment variables:** `REMO_API_KEY=<the host key>`. The supervisor
     must read the key itself, so it goes here, not under "API credentials".
   - **Setup script:**

     ```bash
     #!/bin/bash
     curl -fsSL https://raw.githubusercontent.com/finedesignz/remo-code/main/tools/cloud-session/setup.sh | bash
     ```
3. Start a new session. The host appears in Remo as hostname `vm`.

Optional env: `REMO_HUB_URL`, `REMO_ROOTS` (colon-separated, default
`/home/user`), `REMO_MAX_CONCURRENT` (default 2), `REMO_ALLOW_DANGEROUS=1`
(allow `--dangerously-skip-permissions`), `REMO_CODE_REF` (git ref, default
`main`).

## Debugging

- Logs: `~/.local/state/remo-code-supervisor/supervisor.log` and
  `cloud-stdout.log`.
- `curl -sS "$HTTPS_PROXY/__agentproxy/status"` shows proxy denials; a
  `connect_rejected` for `app.remo-code.com` means the network policy still
  blocks the hub.
