# iOS sideload runbook (Windows-only developer)

This doc covers the "I don't own a Mac" path for building and installing
the Remo Code mobile shell on a personal iPhone. Three pieces:

1. **One-shot:** rent a Mac to run `cargo tauri ios init` once.
2. **Per-release CI:** GitHub Actions `mobile-ios-build` workflow produces an
   unsigned `.ipa` on `macos-14`.
3. **Per-release sideload:** AltStore on Windows re-signs the `.ipa` with a
   free Apple ID and pushes it to the iPhone over USB / Wi-Fi.

This is for personal testing and the user's own dev devices. Real App Store
distribution (TestFlight, public beta, App Store listing) requires a paid
Apple Developer Program account ($99/yr) and is out of scope here.

---

## 1. MacInCloud first-time setup (~30 min, one-shot)

`cargo tauri ios init` is interactive — it shells out to Xcode to lay down
the `gen/apple/` tree (Xcode project, `Info.plist`, entitlements, AppIcon
asset catalog). It only runs on macOS with Xcode installed, so we rent a
Mac for ~30 minutes.

### Sign up

1. Go to https://www.macincloud.com — confirm current pricing on the page.
   At time of writing the Managed Server Plan starts at **$25/month**, and
   they bill monthly. (There used to be a Pay-As-You-Go option; verify
   what's on the live page when you sign up, and pick the smallest plan
   that lets you spin up a single session for less than an hour.)
2. Create the account → pick a Managed Server location near you →
   complete checkout at https://checkout.macincloud.com.
3. Wait for the activation email with RDP credentials.

### Connect from Windows

1. Open Remote Desktop Connection (`mstsc.exe`).
2. Connect with the host + credentials from the activation email.
3. You land on a macOS desktop.

### Install the toolchain on the Mac

```sh
# Xcode (preinstalled on most MacInCloud images — open App Store to confirm
# it's the latest). If not present, install from the Mac App Store. This
# takes 10+ minutes — start it first.
xcode-select --install

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# iOS Rust targets
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# Tauri CLI 2.x (matches the version in .github/workflows/mobile-ios-build.yml)
cargo install tauri-cli --version "^2.0" --locked

# Bun (for the mobile/tauri/ui/ Vite shell)
curl -fsSL https://bun.sh/install | bash
```

### Generate `gen/apple/`

```sh
git clone https://github.com/finedesignz/remo-code.git
cd remo-code
git checkout -b feat/mobile-ios-init

cd mobile/tauri/ui && bun install
cd ..

# Accept defaults. Bundle identifier stays com.finedesignz.remo-code.
# Device family: iPhone + iPad is fine. Team ID: leave blank for unsigned.
cargo tauri ios init
```

This drops `mobile/tauri/src-tauri/gen/apple/` (Xcode project, asset
catalogs, entitlements). Verify with:

```sh
ls mobile/tauri/src-tauri/gen/apple/
```

Commit + push:

```sh
git add mobile/tauri/src-tauri/gen/apple/
git commit -m "feat(12.4): commit cargo tauri ios init output"
git push origin feat/mobile-ios-init
```

Open a PR. Once merged, **disconnect the MacInCloud session and cancel the
plan** — you never have to log back in. Total spend: roughly one month of
the smallest Managed plan.

> **Tip:** If MacInCloud changes pricing or removes their cheapest plan,
> the same workflow runs on any short-term macOS rental: AWS EC2 `mac1.metal`
> instances bill by the hour (~$1/hr, 24h minimum), `scaleway.com` has
> Mac mini M1 rentals starting at €0.10/min, or `xcodecloud.apple.com` if
> you're willing to enroll in Apple Developer first.

---

## 2. AltStore on Windows (one-shot)

AltStore is a sideloading toolchain. Install AltServer on Windows; it
pushes signed `.ipa`s to an iPhone connected over USB or Wi-Fi.

### Install AltServer

1. Go to https://altstore.io → download "AltServer for Windows".
   (Verify the download link on the page before installing.)
2. Install iTunes (Microsoft Store version) and iCloud for Windows from
   Apple — AltServer relies on Apple's Bonjour + USBMUXD bundled with them.
3. Run AltServer. It lives in the Windows tray.

### Pair iPhone

1. Plug iPhone into the PC via USB.
2. On the iPhone: **Settings → Privacy & Security → Developer Mode → On**.
   Reboot when prompted.
3. In iTunes / Apple Devices, trust the PC from the iPhone.
4. From the AltServer tray icon: **Install AltStore → [your iPhone]**.
   Sign in with a free Apple ID (a throwaway one is fine — this Apple ID
   becomes the signing identity for every app sideloaded to that phone).
5. On the iPhone: **Settings → General → VPN & Device Management → Trust**
   the developer profile that just got installed.

AltStore is now installed on the iPhone. AltServer must keep running on
the PC for AltStore to refresh signing certs (free Apple IDs expire signed
apps after 7 days).

---

## 3. Per-release sideload

Every time you want a fresh build on the iPhone:

### Trigger the CI build

1. First time only: enable the workflow.
   - Repo → **Settings → Secrets and variables → Actions → Variables**.
   - Add **`ENABLE_IOS_BUILD = true`**.
2. Repo → **Actions → mobile-ios-build → Run workflow** (main branch is
   fine). For a tagged release, push a tag like `mobile-ios-v0.1.0` and
   the same workflow auto-runs + attaches the `.ipa` to a GitHub Release.
3. Wait ~10 min. The job uploads an artifact
   `remo-code-mobile-ios-<sha>.zip` containing the unsigned `.ipa`.

### Sideload via AltStore

1. Download the artifact zip from the workflow run page → extract the
   `.ipa`.
2. AltStore on the iPhone → **My Apps → + (top-left) → select the .ipa**
   from a folder synced via iCloud Drive / Files / AirDrop, OR
3. From AltServer on Windows: drag the `.ipa` onto the tray icon and pick
   "Install to [device]".
4. AltServer re-signs the `.ipa` with the free Apple ID from step 2 above
   and pushes it to the phone.

Open the app. Done.

---

## Caveats

- **Free Apple ID limits.**
  - Max **3 sideloaded apps** installed at once per Apple ID.
  - Signing cert expires every **7 days** — AltServer auto-refreshes when
    the iPhone is on the same Wi-Fi as the AltServer PC. If you let the
    cert lapse, the app force-quits on launch until you re-sideload.
- **Push notifications won't work** on unsigned / free-cert builds —
  APNS rejects the dev cert. Real push needs a paid Apple Developer
  account + production push certificate.
- **Universal Links won't work** without an entitled `apple-app-site-association`
  match, which also needs a paid Team ID. The fallback custom scheme
  (`remo-code://auth/callback?token=...`) still works — magic-link emails
  open via the custom scheme on sideloaded builds.
- **App Store distribution is a separate path.** Pay $99/yr for the
  Apple Developer Program, then wire `APPLE_CERT_P12` + provisioning
  profile + Team ID through repo secrets, switch the workflow's
  `--export-method` from `debugging` to `app-store`, and submit through
  App Store Connect or `xcrun altool`.

---

## Related files

- `.github/workflows/mobile-ios-build.yml` — the CI workflow this runbook
  drives.
- `mobile/tauri/README.md` — high-level mobile shell layout.
- `docs/mobile-client.md` — Phase 12 architecture (deep link, finalize
  endpoint, lifecycle expectations).
