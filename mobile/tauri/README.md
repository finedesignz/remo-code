# Remo Code mobile shell

Thin Tauri 2.x WebView wrapper for iOS and Android. The real UI is the hosted
web SPA at `https://app.remo-code.com`; this shell exists to (a) ship a binary
through the App Store / Play Store and (b) own the `remo-code://auth/callback`
deep link that closes the magic-link sign-in loop.

## Layout

```
mobile/tauri/
  src-tauri/           # Rust crate (cdylib for mobile entry point)
    Cargo.toml
    tauri.conf.json
    src/lib.rs         # mobile_entry_point + deep-link handler
    src/main.rs        # desktop fallback entry
    capabilities/      # Tauri capability ACLs
    icons/             # source PNG goes here (NOT committed yet)
  ui/                  # minimal Vite shell that location.replace()s to the SPA
    package.json
    vite.config.ts
    index.html
    src/main.ts
```

## Releases

Tagged preview builds (Windows MSI + NSIS setup.exe + Android APK) are
published to GitHub Releases by `.github/workflows/release-mobile.yml`.

- **Cut a release:** push a tag matching `mobile-v*.*.*` to `main`.
  ```bash
  git tag mobile-v0.1.0
  git push origin mobile-v0.1.0
  ```
  The workflow fans out to `build-windows` (Windows MSI + NSIS) and
  `build-android` (universal APK) in parallel, then a `release` job uploads
  every artifact to the GitHub Release page.
- **Download:** <https://github.com/finedesignz/remo-code/releases?q=mobile-v>
- **Artifacts are UNSIGNED.** Windows SmartScreen will warn on first run;
  Android requires "Install unknown apps" permission. Code-signing for
  both platforms is a follow-up PR.
- **iOS** is a separate workflow (`mobile-ios-build.yml`), gated by repo
  variable `ENABLE_IOS_BUILD=true` — see [`docs/ios-sideload.md`](../../docs/ios-sideload.md).

## Dev / build

```bash
cd mobile/tauri/ui && bun install
cd mobile/tauri && cargo check --manifest-path src-tauri/Cargo.toml
```

### Desktop preview build (Windows / macOS / Linux)

`mobile/tauri/src-tauri/src/main.rs` is the desktop entry point; the same
crate builds a normal native window that loads `https://app.remo-code.com`
in a WebView, exercising the deep-link → finalize-mobile → SPA round-trip
without an iOS or Android host. Use this for local iteration.

```bash
cd mobile/tauri/ui && bun install
cd mobile/tauri && cargo tauri build --debug
```

Artifacts (Windows host, debug profile):

- `src-tauri/target/debug/remo-code-mobile.exe`              — raw executable
- `src-tauri/target/debug/bundle/msi/Remo Code_*.msi`        — MSI installer
- `src-tauri/target/debug/bundle/nsis/Remo Code_*-setup.exe` — NSIS installer

`tauri.windows.conf.json` opts `msi` + `nsis` bundle targets in for the
Windows host only; `tauri.conf.json` keeps the mobile `app` + `apk` bundle
targets canonical, and the `app.windows[main]` config is ignored by the
mobile entry point at runtime.

Preview installers are unsigned — Windows SmartScreen will flag them on
first launch. That's expected; signed releases come with Phase 12.5.

### iOS (Mac host required)

```bash
cd mobile/tauri
cargo tauri ios init                 # generates gen/apple/ — Xcode project
cargo tauri ios dev                  # iOS simulator
cargo tauri ios build --release      # .ipa for TestFlight / App Store
```

### Android (host with Android SDK + NDK required)

`gen/android/` IS committed (Phase 12.4) so a fresh checkout can build without
re-running `init`.

```bash
# one-time per machine — see "Toolchain bootstrap" appendix for details
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

cd mobile/tauri/ui && bun install && bun run build
cd mobile/tauri
cargo tauri android dev                              # adb-attached device or emulator
cargo tauri android build --debug --apk --target aarch64    # debug APK, ARM64 phones
cargo tauri android build --release --apk            # signed .apk / .aab for Play Store (Phase 12.5)
```

Debug APK lands at:

```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

#### Sideload to a phone (USB)

1. Enable Developer Options + USB Debugging on the phone.
2. `adb devices` — confirm phone is listed.
3. `adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
4. Launch "Remo Code" from the app drawer.

#### Sideload to BlueStacks / emulator

Drag-and-drop the `.apk` onto the BlueStacks window, or use the **Install APK**
button in Multi-Instance Manager. For Android Studio AVD: `adb -s emulator-5554
install -r <apk>`.
## iOS development without owning a Mac

The Windows-only developer path: rent a Mac for ~30 minutes once to run
`cargo tauri ios init`, then every subsequent build runs in GitHub Actions
on `macos-14`, and the unsigned `.ipa` ships to a personal iPhone via
AltStore re-signing with a free Apple ID. Full runbook in
[`../../docs/ios-sideload.md`](../../docs/ios-sideload.md).

The one-time MacInCloud step IS the Phase 12.4 iOS prep below — once
`gen/apple/` is committed, the `.github/workflows/mobile-ios-build.yml`
workflow handles every build after that.

## Deferred platform generation

The `gen/apple/` and `gen/android/` trees are **not** committed on this branch.
They are generated by `cargo tauri ios init` / `cargo tauri android init` on a
host with the matching toolchain (Xcode 15+ on macOS; Android SDK 34 + NDK r26+
on macOS/Linux/Windows). Once generated, commit the lockfile + project files
(but `.gitignore` the build artefacts) in a follow-up PR.

Phase 12.4 status:

1. iOS — `cargo tauri ios init` on a Mac, commit `gen/apple/`. **Pending (MacInCloud track).**
2. Android — `cargo tauri android init` + debug APK build. **Shipped on `feat/mobile-android` — Android Studio NDK 27.3.13750724 verified on Windows 11.**
3. Re-fan-out iOS/Android icon variants from `src-tauri/icons/icon.png` (Android mipmaps now in `gen/android/app/src/main/res/mipmap-*`).
4. Replace the placeholder icon source with a real brand asset.
5. Configure code-signing (Apple Developer Program; Google Play upload key) — **Phase 12.5**.
6. Wire `mobile-shell-release.yml` for tagged `mobile-v*.*.*` builds — **Phase 12.5**.

## Deep-link contract

OS receives `remo-code://auth/callback?token=<X>` → Rust handler in
`src/lib.rs::handle_deep_link` parses the token → evals JS in the WebView that
POSTs `{ token }` to `https://app.remo-code.com/api/auth/finalize-mobile` with
`credentials: 'include'`. On 200 → `location.replace('https://app.remo-code.com')`.
On error → `alert(...)` + `location.reload()`.

The hub-side `/api/auth/finalize-mobile` endpoint shipped in PR #105
(Phase 12.1) — see `hub/src/api/auth.ts` and `docs/mobile-client.md` for
the request/response contract.

## CSP

`tauri.conf.json` `connect-src` allows `https://app.remo-code.com` and
`wss://app.remo-code.com` so the embedded SPA can reach the hub's REST API and
the `/ws/client` WebSocket from inside the WebView origin.

## Toolchain bootstrap (Android, Windows 11)

Verified against the build that produced `RemoCode-Mobile-Preview-0.1.0.apk`:

| Component             | Version / path                                                              |
|-----------------------|------------------------------------------------------------------------------|
| Cargo / rustc         | 1.89.0                                                                       |
| `cargo-tauri`         | 2.11.2                                                                       |
| Android SDK           | `%LOCALAPPDATA%\Android\Sdk` (Android Studio install)                        |
| Platform              | `android-36.1`                                                               |
| Build-tools           | `36.1.0`, `37.0.0`                                                           |
| Platform-tools (adb)  | `37.0.0`                                                                     |
| Command-line tools    | `latest` (downloaded from `dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip`) |
| NDK                   | `27.3.13750724` (Tauri 2 LTS)                                                |
| JDK / JBR             | `C:\Program Files\Android\Android Studio\jbr` (OpenJDK 21.0.10)              |
| Rust Android targets  | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` |

### User-scope env vars (no UAC, persisted via `[Environment]::SetEnvironmentVariable(..., 'User')`)

| Var            | Value                                                       |
|----------------|-------------------------------------------------------------|
| `JAVA_HOME`    | `C:\Program Files\Android\Android Studio\jbr`               |
| `ANDROID_HOME` | `C:\Users\<you>\AppData\Local\Android\Sdk`                  |
| `ANDROID_SDK_ROOT` | (same as `ANDROID_HOME`)                                |
| `NDK_HOME`     | `%ANDROID_HOME%\ndk\27.3.13750724`                          |
| `PATH` adds    | `%JAVA_HOME%\bin`, `%ANDROID_HOME%\platform-tools`, `%ANDROID_HOME%\cmdline-tools\latest\bin` |

### One-shot bootstrap on a fresh Windows machine

```powershell
# 1. Install Android Studio (gives you SDK + JBR).
# 2. Download cmdline-tools (Android Studio doesn't ship them by default):
$url = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Invoke-WebRequest $url -OutFile "$env:TEMP\cmdt.zip"
Expand-Archive "$env:TEMP\cmdt.zip" -DestinationPath "$env:TEMP\cmdt-stage" -Force
New-Item -ItemType Directory -Force -Path "$sdk\cmdline-tools" | Out-Null
Move-Item "$env:TEMP\cmdt-stage\cmdline-tools" "$sdk\cmdline-tools\latest"

# 3. Accept licenses + install NDK
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses     # pipe `y` for each
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" "ndk;27.3.13750724"

# 4. Persist user env vars (no admin needed)
[Environment]::SetEnvironmentVariable('JAVA_HOME','C:\Program Files\Android\Android Studio\jbr','User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME',$sdk,'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT',$sdk,'User')
[Environment]::SetEnvironmentVariable('NDK_HOME',"$sdk\ndk\27.3.13750724",'User')
```

### Verify

```powershell
java -version            # OpenJDK 21.x
adb version              # 1.0.41 / Version 37.0.0
sdkmanager --list_installed
```
