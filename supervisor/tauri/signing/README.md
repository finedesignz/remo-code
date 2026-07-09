# Supervisor MSI — Azure Trusted Signing scaffold

Authenticode code-signing for the Remo Code Supervisor MSI, backed by
**Azure Trusted Signing** (aka "Artifact Signing"). This is a **gated scaffold**: it is
completely inert until a certificate profile exists and the gate is flipped on. Until then
the release workflow builds the same unsigned MSI it builds today.

## Files

| File | Purpose |
|------|---------|
| `sign.ps1` | Per-artifact signer Tauri invokes via `bundle.windows.signCommand` (`%1` = artifact path). Resolves `signtool` from the Windows SDK, requires env `TRUSTED_SIGNING_DLIB`, reads `trusted-signing-metadata.json`, calls `signtool sign /fd SHA256 /tr <timestamp> /td SHA256 /dlib <dll> /dmdf <metadata>`. **Fails closed** (non-zero exit) if the dlib env is unset or missing, so a misconfigured build never ships unsigned. |
| `trusted-signing-metadata.json` | Static `Endpoint` / `CodeSigningAccountName` / `CertificateProfileName` passed to the dlib. The workflow may overwrite `CertificateProfileName` from `CERT_PROFILE_NAME` at build time. |

## The gate

Signing is controlled by the repo **variable** `ENABLE_MSI_SIGNING`:

- **Unset / not `'true'` (current state):** no signing steps run. The committed
  `tauri.conf.json` has **no** `signCommand`, so `sign.ps1` is never invoked. The release is
  byte-for-byte the same unsigned MSI as before. The Azure secrets passed to `tauri-action`
  are ignored.
- **`'true'`:** the workflow installs the Trusted Signing dlib, optionally overrides the cert
  profile name, injects `bundle.windows.signCommand` into `tauri.conf.json` for that build, and
  passes the Azure service-principal creds to `tauri-action`.

The committed `tauri.conf.json` intentionally never carries a `signCommand` — it is injected
only in-CI when the gate is on.

## Required GitHub secrets

Already set on the repo (service principal with the "Artifact Signing Certificate Profile
Signer" role on account `titaniumlabs-signing`):

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_SECRET`

Optional: `CERT_PROFILE_NAME` (repo variable or secret) to override the profile name without a
code edit.

## How to flip it on

1. Finish Microsoft identity validation and **create the certificate profile** in the
   `titaniumlabs-signing` account. Intended name: `titaniumlabs-public-trust` (the committed
   default in `trusted-signing-metadata.json`).
2. If the actual profile name differs, either edit `trusted-signing-metadata.json` or set the
   repo variable/secret `CERT_PROFILE_NAME`.
3. Set the repo **variable** `ENABLE_MSI_SIGNING=true`
   (`gh variable set ENABLE_MSI_SIGNING --body true`).
4. Push a `supervisor-v*.*.*` tag as usual.

## Why signing happens during bundling (not after)

Tauri's updater signature (`.sig`, from `TAURI_SIGNING_PRIVATE_KEY`) is computed over the final
MSI bytes. `bundle.windows.signCommand` runs **during** bundling, so Authenticode signing
happens *before* the updater `.sig` is generated — the `.sig` covers the signed MSI and the
in-app auto-updater verifies correctly. A post-build `signtool` step (after `tauri-action`)
would sign the MSI *after* its `.sig` was already produced, breaking updater verification. That
is why the seam is `signCommand`, not a trailing step.

## Fail-closed behavior

`sign.ps1` exits non-zero (failing the build) if `TRUSTED_SIGNING_DLIB` is unset/missing, the
artifact path is absent, the metadata file is missing, or `signtool` can't be found. A signing
build that is misconfigured fails loudly rather than silently shipping an unsigned MSI.
