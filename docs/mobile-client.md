# Mobile client

## Mobile shell (Phase 12.3)

Remo Code ships a native iOS/Android app via a thin Tauri 2.x WebView wrapper
that loads the hosted SPA at `https://app.remo-code.com`. The shell lives at
`mobile/tauri/` and is the only piece that needs to be rebuilt per native
release; the SPA itself ships continuously through the hub's Docker image.

### Why a shell, not a port

- One UI codebase. The web SPA already runs in every browser; re-implementing
  it in React Native / Flutter would duplicate every Phase 03 grid-view fix,
  every scheduler UI tweak, every error-capture drawer.
- Native deep links. The `remo-code://auth/callback?token=<X>` scheme can only
  be claimed by a native binary registered with the OS. The shell exists
  primarily to own that scheme.
- App Store presence. Distribution + push-notification entitlements + biometric
  unlock (deferred) all require a real binary.

### Architecture

```
OS magic-link tap
  → remo-code://auth/callback?token=<X>
  → mobile shell (src-tauri/src/lib.rs handle_deep_link)
  → WebView eval: POST /api/auth/finalize-mobile { token } credentials: include
  → hub sets opaque session cookie on WebView cookie jar
  → location.replace(https://app.remo-code.com)
  → full SPA loads, authenticated
```

### Files

- `mobile/tauri/src-tauri/Cargo.toml` — Tauri 2.11 + `tauri-plugin-deep-link`.
  Versions match `supervisor/tauri/src-tauri/Cargo.toml` exactly.
- `mobile/tauri/src-tauri/tauri.conf.json` — identifier `com.finedesignz.remo-code`,
  scheme `remo-code://`, productName `Remo Code`, version `0.1.0`, CSP allowing
  `https://app.remo-code.com` and `wss://app.remo-code.com`.
- `mobile/tauri/src-tauri/src/lib.rs` — `#[tauri::mobile_entry_point]` run()
  function + deep-link handler that escapes the token through `serde_json` and
  evals a fetch+reload JS snippet in the WebView.
- `mobile/tauri/src-tauri/capabilities/default.json` — grants `deep-link`,
  `shell`, `os`, `http` to the `main` window.
- `mobile/tauri/ui/` — minimal Vite entry whose `main.ts` immediately
  `location.replace`s to `VITE_REMO_URL` (defaults to `https://app.remo-code.com`)
  after stashing `window.__REMO_APP_VERSION__` in `sessionStorage`.

### Hub-side companion (Phase 12.4)

The shell expects `POST /api/auth/finalize-mobile` to exist on the hub. That
endpoint is **not implemented on this branch** — it is Phase 12.4's deliverable
and must:

1. Accept `{ token }` from a same-origin POST with `credentials: include`.
2. Validate the token against Titanium Licensing (same path as the existing
   web magic-link callback at `hub/src/api/auth.ts`).
3. Mint an opaque `auth_sessions` row + set the session cookie with
   `SameSite=None; Secure` so iOS/Android WebViews accept it.
4. Return 200 with `{ ok: true }`.

### Deferred to Phase 12.4

- `gen/apple/` (Xcode project) — `cargo tauri ios init` on a Mac.
- `gen/android/` (Gradle project) — `cargo tauri android init` on an Android
  SDK + NDK host.
- `src-tauri/icons/icon.png` — 1024×1024 source PNG, then `cargo tauri icon`.
- Hub endpoint `/api/auth/finalize-mobile`.
- Release workflow for `mobile-v*.*.*` tags.
- Code-signing setup (Apple Developer Program, Google Play upload key).

### CI

`.github/workflows/mobile-shell-typecheck.yml` runs `cargo check` against the
host x86_64-unknown-linux-gnu target on every push that touches `mobile/tauri/`.
This catches Rust regressions without needing Android NDK or Xcode in CI; the
real mobile build matrix lands with Phase 12.4.
