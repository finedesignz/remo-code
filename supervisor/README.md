# remo-code-supervisor

Local supervisor for Remo Code — manage and remote-launch `claude-code` sessions in your local repos from the Remo Code web UI.

## Prerequisites

- Windows 10/11 (other OSes can run the foreground mode but not the service)
- [Bun](https://bun.sh) installed and on PATH
- `claude` CLI installed and on PATH
- `git` on PATH
- A Remo Code account with an API key (https://app.remo-code.com → Settings → API Keys)

## Install

```powershell
npx remo-code-supervisor install `
  --api-key olx_xxx `
  --roots "C:\Users\you\GitHub" `
  --service-user ".\you" `
  --service-password "<your windows password>"
```

This installs a Windows Service named `RemoCodeSupervisor` (via NSSM) that runs as your user, auto-starts at boot, and stays connected to the hub.

If you don't supply `--service-user`/`--service-password`, the service is created but runs as LocalSystem — which **cannot read your SSH keys, `gh` auth, or `~/.config`**. Strongly prefer running as your own user.

## Run in foreground (no service)

```powershell
npx remo-code-supervisor run
```

## Other commands

```powershell
npx remo-code-supervisor status      # service status
npx remo-code-supervisor scan        # list discovered repos
npx remo-code-supervisor uninstall   # remove the service
```

## Config file

`%APPDATA%\remo-code\supervisor.json`

```json
{
  "api_key": "olx_xxx",
  "hub_url": "https://app.remo-code.com",
  "roots": ["C:\\Users\\you\\GitHub"],
  "max_concurrent": 1
}
```

## Logs

`%LOCALAPPDATA%\remo-code\logs\stdout.log` and `stderr.log` (rotating at 10MB).

## License

MIT
