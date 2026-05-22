# Supervisor Feature — What to Do When You're Back at the Desk

Status as of 2026-05-22 ~12:20 PDT:

| Piece | Status |
|---|---|
| Spec | ✅ `docs/superpowers/specs/2026-05-22-supervisor-remote-control-design.md` |
| Hub code | ✅ All routes, WS handlers, DB migration deployed to `app.remo-code.com` |
| Web UI | ✅ `#/supervisor` route live (sidebar has a new icon — second from left in the footer) |
| Supervisor npm package | ✅ Code on `main`; `publish-supervisor.yml` workflow triggered on push. Verify it published below. |
| **GitHub App** | ❌ **Not registered yet — you must do this.** |
| **Coolify env vars** | ❌ **Not set yet — you must do this.** |
| **Supervisor installed on your PC** | ❌ **You must run install command.** |

The feature is gated behind these three steps. Until they're done, the UI will show "GitHub App not configured on hub" and no supervisor will appear. Plan to spend ~15 minutes on this.

---

## Step 1 — Verify the supervisor was published to npm

The `publish-supervisor.yml` workflow triggers on push and publishes via trusted publishing (OIDC). Check it succeeded:

```powershell
npm view remo-code-supervisor version
```

Expected: `0.1.0`. If you get a 404:

- Look at https://github.com/finedesignz/remo-code/actions for the workflow run.
- If trusted-publishing failed (new package), you may need to **pre-register the trusted publisher** at https://www.npmjs.com/package/remo-code-supervisor (it'll prompt you the first time). Re-run the failed workflow.
- Or just publish manually once: `cd supervisor && npm publish --access public`.

---

## Step 2 — Register the GitHub App

This grants the hub permission to list your repos and clone them on demand.

1. Go to https://github.com/settings/apps/new
2. Fill in:
   - **GitHub App name**: `Remo Code` (or similar — slug must be unique across GitHub)
   - **Homepage URL**: `https://app.remo-code.com`
   - **Webhook → Active**: uncheck (we don't need webhooks for v1)
   - **Callback URL**: `https://app.remo-code.com/api/github/callback`
   - **Request user authorization (OAuth) during installation**: uncheck
   - **Setup URL**: leave blank
3. **Repository permissions**:
   - Contents: **Read & write**
   - Metadata: **Read-only** (auto-selected)
   - Pull requests: **Read-only**
4. **Where can this GitHub App be installed?** → Only on this account
5. Create.
6. On the next page:
   - Note the **App ID** (top of page).
   - Note the slug from the URL (e.g. `remo-code`).
   - Scroll down → **Private keys → Generate a private key**. A `.pem` file downloads.

---

## Step 3 — Set 3 env vars in Coolify

In Coolify UI for the `remo-code` app (UUID `zewfc6g9dw3c4h88z2jd2o4g`), Environment Variables:

| Key | Value |
|---|---|
| `GITHUB_APP_ID` | the App ID number from step 2 |
| `GITHUB_APP_SLUG` | the slug (e.g. `remo-code`) |
| `GITHUB_APP_PRIVATE_KEY` | base64-encoded contents of the .pem file |

To base64-encode the .pem on Windows PowerShell:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\remo-code.private-key.pem"))
```
Paste the (long, single-line) result as the value for `GITHUB_APP_PRIVATE_KEY`.

Redeploy the app. The "GitHub App not configured on hub" banner should disappear.

---

## Step 4 — Connect your GitHub account

1. Open https://app.remo-code.com/#/supervisor
2. Click **Connect GitHub** in the GitHub card.
3. Install the App on your account, picking either "All repositories" or specific ones.
4. You'll be redirected back to `#/supervisor?github=connected`.
5. Your repos should now populate the list under filter `github`.

---

## Step 5 — Install the supervisor on your Windows PC

```powershell
# 1. Make sure your API key is current; rotate if unsure:
#    Visit https://app.remo-code.com/#/settings → API Key → Rotate Key

# 2. Install the supervisor as a Windows Service:
npx remo-code-supervisor install `
  --api-key "olx_xxx_or_remokey_..." `
  --roots "C:\Users\artic\GitHub" `
  --service-user ".\artic" `
  --service-password "<your Windows password>"
```

Notes:
- The `--service-user` / `--service-password` makes the service run as you, so `gh`, SSH keys, and `~/.config` work.
- If you skip the user/password, the service runs as LocalSystem and `gh`/SSH won't work — strongly discouraged.
- NSSM is required. The installer prints a message with a download link if it's not present at `%LOCALAPPDATA%\remo-code\nssm.exe`. Grab nssm-2.24, copy `win64/nssm.exe` to that path, then re-run install.

Verify it's running:
```powershell
npx remo-code-supervisor status
Get-Service RemoCodeSupervisor
```

Logs: `%LOCALAPPDATA%\remo-code\logs\stdout.log` and `stderr.log`.

---

## Step 6 — Use it

1. https://app.remo-code.com/#/supervisor — your machine should appear with a green dot ("idle").
2. Click **Rescan** to populate the local repo list.
3. Pick a repo → **Start** → choose branch, optionally enable `git pull`, optionally type an initial prompt → **Start session**.
4. The supervisor spawns `claude` in that repo. Browse back to the chat view to interact normally.
5. To stop: come back to `#/supervisor` and click **Stop**.

If you want to clone a GitHub repo that's not local yet, switch the filter to `github`, find it, click **Clone & Start**. It clones into the first configured root then immediately starts a session.

---

## Known v1 limitations (deferred to v2)

- One inner Claude session per supervisor at a time (parallelism via Task tool inside Claude).
- "Take over" of an existing VS Code Claude instance not implemented yet (you said v2).
- macOS / Linux: supervisor runs in foreground mode (`npx remo-code-supervisor run`) but no service installer.
- `git pull` from the Start dialog is best-effort — proper tokenized-URL pull from supervisor still needs the hub to send a one-shot URL; current build skips it with a log message. Easy follow-up.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Supervisor doesn't appear in UI | `npx remo-code-supervisor status` — is the service running? `stderr.log` for connection errors. Verify API key is current. |
| "Supervisor offline" 503 on Start | Service is down. Restart with `Restart-Service RemoCodeSupervisor`. |
| GitHub repo list empty after install | Re-install the App to add specific repos. The hub re-fetches on each `/api/github/repos` hit (60s cache). |
| "Claude not found" in stderr.log | `claude` CLI missing from the service user's PATH. Install Claude Code CLI for that user. |
| Service crashed 5x in 10min → "Stopped" state | Circuit breaker tripped. Check the run's stderr tail in the UI runs drawer. Click Start again after fixing. |

---

Spec for full design context: [`docs/superpowers/specs/2026-05-22-supervisor-remote-control-design.md`](superpowers/specs/2026-05-22-supervisor-remote-control-design.md)
