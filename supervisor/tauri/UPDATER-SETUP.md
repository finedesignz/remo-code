# Tauri Updater — One-Time Key Setup

The supervisor auto-updater verifies every downloaded installer (per-user NSIS
`-setup.exe`) against an Ed25519
public key baked into the app. The matching private key signs releases in CI.
This file documents the one-time setup the maintainer has to do **before
shipping the first auto-updating release**.

> TODO (maintainer): the value of `plugins.updater.pubkey` in
> `src-tauri/tauri.conf.json` is still the placeholder
> `REPLACE_WITH_TAURI_UPDATER_PUBKEY`. Run the keygen below, then commit the
> public key into that field. Until you do, the in-app updater will fail
> signature verification on every release.

## 1. Generate the key pair (one machine, one time)

```bash
# pick any private-key path you control — keep the file OFF of git
cargo tauri signer generate -w ~/.tauri/remo-supervisor.key
```

You'll be prompted for a password. **Use a strong one and save it in your
password manager** — losing it means re-keying every installed copy of the
supervisor.

The command prints two things:
- the path to the private key file (e.g. `~/.tauri/remo-supervisor.key`)
- a base64 **public key** (single line, starts with `dW50cnVzdGVkIGNvbW1lbnQ6...`)

## 2. Paste the public key into the app config

Edit `supervisor/tauri/src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/finedesignz/remo-code/releases/latest/download/latest.json"],
    "pubkey": "<PASTE THE BASE64 PUBLIC KEY HERE>"
  }
}
```

Commit and push. From this point on, every installed supervisor binary will
only accept updates signed by this private key.

## 3. Store the private key in GitHub Actions secrets

```bash
# base64-encode the private key file (one line, no wrapping)
base64 -w 0 ~/.tauri/remo-supervisor.key > remo-supervisor.key.b64
```

In **Settings → Secrets and variables → Actions** on the `finedesignz/remo-code`
repo, add two repo-level secrets:

| Name                                  | Value                                |
|---------------------------------------|--------------------------------------|
| `TAURI_SIGNING_PRIVATE_KEY`           | contents of `remo-supervisor.key.b64`|
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`  | the password you set in step 1       |

Delete `remo-supervisor.key.b64` from disk afterwards. **Never commit it.**

## 4. Verify

Cut a test release:

```bash
git tag supervisor-v0.3.1
git push origin supervisor-v0.3.1
```

Watch `.github/workflows/release-supervisor.yml`. On success, the release page
should contain at minimum:

- `Remo Code Supervisor_<version>_x64-setup.exe`
- `Remo Code Supervisor_<version>_x64-setup.exe.sig`
- `latest.json` — the signed manifest the in-app updater fetches

## 5. Rotating the key

If the private key is ever exposed:

1. Generate a new key pair (step 1).
2. Update `plugins.updater.pubkey` in `tauri.conf.json` (step 2).
3. Replace both GitHub Actions secrets (step 3).
4. **Critical:** every currently-installed supervisor will refuse the next
   update because its baked-in public key no longer matches. Users have to
   reinstall the -setup.exe manually from the release page **once**. Document this
   in the release notes for the rotation release.
