# Phase 12 (Mobile Tauri Client) — Re-plan review

**Reviewer:** Backend Architect subagent
**Base:** `origin/main` @ `35fa2c9` (2026-05-28)
**Merged sub-phases:** PR #105 (12.1 hub) · PR #110 (12.2 web) · PR #111 (12.3 Tauri scaffold)

> **PLAN.md not in git.** The canonical `.planning/phases/12-mobile-tauri-client/PLAN.md`
> referenced from PR #105 body, PR #111 body, and `docs/mobile-client.md:312` was
> never committed to any branch (`gh api …PLAN.md?ref=feat/mobile-tauri` → 404;
> `git log --all --diff-filter=A -- '.planning/phases/12-mobile-tauri-client/**'` → empty;
> `git ls-tree -r origin/feat/mobile-tauri` confirms absent). Replan reconstructs
> 12.4 / 12.5 / 12.6 intent from PR #105 / #111 bodies + `docs/mobile-client.md` +
> `mobile/tauri/README.md` "Phase 12.4 owns" list.

---

## Section 1 — Plan status

Reconstructed scope per PR #111 body + `mobile/tauri/README.md:60-66`.

### 12.4 — Platform generation + hub finalize endpoint + signing
| Item | Status | Reason |
|---|---|---|
| `gen/apple/` via `cargo tauri ios init` (Mac host) | **STILL VALID** | Not present on main (`ls mobile/tauri/` confirms no `gen/`); Mac host still required. |
| `gen/android/` via `cargo tauri android init` (SDK+NDK host) | **STILL VALID** | Not present on main; SDK/NDK host requirement unchanged. |
| `src-tauri/icons/icon.png` + `cargo tauri icon` fan-out | **STILL VALID** | `mobile/tauri/src-tauri/icons/` contains only `.gitkeep` (timestamp 2026-05-28). |
| `POST /api/auth/finalize-mobile` hub endpoint | **OBSOLETE** | **Already shipped in PR #105** at `hub/src/api/auth.ts:353-358`. `mobile/tauri/README.md:78-80` claim "not yet implemented" is stale. |
| Code-signing setup (Apple cert, Play upload key) | **STILL VALID** | No signing keys in repo secrets list. |

### 12.5 — Release CI
| Item | Status | Reason |
|---|---|---|
| `mobile-shell-release.yml` for `mobile-v*.*.*` tags | **STILL VALID** | Only `mobile-shell-typecheck.yml` exists on main. Tagged release workflow absent. |
| macos-latest matrix for iOS + ubuntu-latest for Android | **STILL VALID** | No precedent on main; supervisor release flow is Windows-only (`release-supervisor.yml`), no reuse possible. |
| Tauri updater key reuse | **NEEDS REVISION** | Supervisor key is desktop-only; mobile stores handle updates. Plan should drop updater-key step and substitute App Store / Play Console upload. |

### 12.6 — Docs / version / release
| Item | Status | Reason |
|---|---|---|
| `docs/mobile-client.md` complete coverage of 12.1/12.2/12.3 | **STILL VALID, ALMOST DONE** | All three sub-phases documented (`docs/mobile-client.md:1`, `:168`, `:239`). Dead link at `:312` to non-existent PLAN.md must be removed or replaced. |
| `CLAUDE.md` Phase 12 mobile section | **STILL VALID, DONE** | Present at `CLAUDE.md:457-483`. Note: `CLAUDE.md:108` "Deferred to Phase 12.4" subsection is in the 12.3 README excerpt block and lists items already resolved; review for cleanup. |
| Version bump + git tag + Coolify deploy verify | **NEEDS REVISION** | No deployable hub artifact for 12.4 (mobile-only PR). Bump applies to `mobile/tauri/src-tauri/Cargo.toml` + `tauri.conf.json` + `ui/package.json` lockstep, tag `mobile-v0.2.0`. No `/health` poll — first release verified via TestFlight / Play Internal Testing. |

---

## Section 2 — Drift from main

Commits on `origin/main` after PR #111 merge (2026-05-28 16:45 UTC) that affect Phase 12 assumptions:

| SHA | Title | Phase 12 impact |
|---|---|---|
| `9c9ebdc` | fix(ws/client): gate mutating messages on license_status (#104) | **HIGH.** `hub/src/ws/client.ts` now refuses `send_message`/`permission_response`/`question_response` when `license_status != 'active'`. Mobile must surface a license-expired UX from `/ws/client` errors, not just HTTP 402. Affects 12.4 acceptance criteria (cookie-only auth path was assumed sufficient). |
| `4e7d2fe` | feat(session): authoritative inventory push + idle teardown (#128) | **MEDIUM.** `REMO_SESSION_IDLE_GRACE_SECONDS` default 300s — if mobile WebView backgrounds (iOS suspends WS) and crosses 5min, supervisor kills the claude runner. Mobile must reconnect-and-resume on foreground, not assume the session is still warm. Documented expectation needed in `docs/mobile-client.md`. |
| `35fa2c9` | feat(session): auto-resume orphans on web client connect; respect user_stopped (#133) | **LOW-positive.** Mobile reconnect after backgrounding will now auto-resume orphaned sessions, partially mitigating #128's teardown. |
| `bb86bfa` | fix(web): reactive supervisor + session updates over WS (#130) | **LOW.** WS event additions on `/ws/client` — mobile inherits for free via the hosted SPA. No mobile-shell action. |
| `e1f8618` | fix(web-error-boundary): top-level boundary (#135) | **LOW-positive.** Mobile inherits white-screen recovery for free. |
| `cb680e0` / `dac9a8a` / `c9adcbf` (telegram tracks) | Telegram bridge fixes | None. Different Phase 12 stream (`12-telegram-bridge/`). |

**No CSP-breaking changes** on main since 12.3 — `mobile/tauri/src-tauri/tauri.conf.json` `connect-src` (`https://app.remo-code.com wss://app.remo-code.com`) still matches all current hub origins.

**No dependency churn** in `hub/package.json` or `web/package.json` that would affect the WebView (verified via `git log --oneline -- hub/package.json web/package.json` since merge — no commits).

**Supervisor Tauri version unchanged** since 12.3 — both `supervisor/tauri/src-tauri/Cargo.toml` and `mobile/tauri/src-tauri/Cargo.toml` pin `tauri 2.11.2 / tauri-build 2.6.2 / tauri-plugin-shell 2.3.5`. Lockstep invariant from PR #111 holds.

---

## Section 3 — New blockers / opportunities

### Blockers (none critical)

- **`mobile/tauri/README.md:78-80` is stale** — claims `finalize-mobile` not implemented when PR #105 shipped it. Misleading for any new contributor.
- **`docs/mobile-client.md:312` dead link** to PLAN.md that does not exist in git.
- **`CLAUDE.md:108`** repeats outdated "deferred" list inside an excerpted block; the embedded "Hub-side `POST /api/auth/finalize-mobile`" line is now wrong.

### Opportunities

- **Idle-teardown grace (`REMO_SESSION_IDLE_GRACE_SECONDS=300`, PR #128)** + **auto-resume orphans (PR #133)** together give mobile a clean lifecycle: foreground → resume, 5min background → killed, next foreground → auto-resumed. No mobile-shell code needed — just docs.
- **Top-level error boundary (PR #135)** removes a class of WebView white-screen failures that would have been hard to debug remotely.
- **`/ws/client` license gate (PR #104)** means the mobile shell does not need to add HTTP-only license checks — WS-level enforcement is now uniform.
- **`mobile-shell-typecheck.yml`** already in place — CI safety net is live for any Rust regressions before 12.4 lands signing.
- **Desktop Tauri preview is viable from this Windows box.** `cargo tauri --version` is 2.11.2 locally; the existing `src/main.rs` desktop fallback (PR #111) plus `mobile/tauri/ui/` Vite shell can `cargo tauri dev` straight into a Windows window — exercising the deep-link handler, the `https://app.remo-code.com` redirect, and the WebView CSP without an Android/iOS host.

---

## Section 4 — Recommended next move

**Open a "12.3.1 — desktop preview + stale-doc sweep" PR BEFORE 12.4.**

Rationale:

1. **Desktop preview validates the full 12.3 contract on Windows.** The deep-link → fetch → `location.replace` round-trip can be exercised against the live production hub today. If anything in PR #105's `/api/auth/finalize-mobile` or the Tauri-origin cookie path is broken end-to-end, we want to discover it now — not after spending a Mac host's worth of effort on `gen/apple/`.
2. **Stale docs poison 12.4 onboarding.** `mobile/tauri/README.md:78` actively lies about finalize-mobile status; `docs/mobile-client.md:312` is a dead link; `CLAUDE.md:108` deferred list is contradictory. Fixing these in the same PR as the preview makes 12.4's brief accurate.
3. **No blockers.** Tauri CLI 2.11.2 already installed locally; mobile crate's `src/main.rs` already builds for desktop (PR #111). One `bun install` in `mobile/tauri/ui/` + one `cargo tauri dev`.
4. **12.4 still has the same long-pole cost** (Mac for iOS, signing certs) — running the preview first does not delay it; it de-risks it.

**Concrete next PR scope:**

- `cd mobile/tauri/ui && bun install`
- `cd mobile/tauri && cargo tauri dev` — verify window opens, redirects to `https://app.remo-code.com`, magic-link login completes against production.
- Fix `mobile/tauri/README.md:78-80` (finalize-mobile now shipped — change wording + cite `hub/src/api/auth.ts:358`).
- Replace `docs/mobile-client.md:312` link with `mobile/tauri/README.md` reference, or commit a real PLAN.md (recommended: write a proper plan now using this replan as input).
- Audit `CLAUDE.md:108` block — strip the "Hub-side finalize-mobile" deferred line.
- Add a `docs/mobile-client.md` subsection covering PR #128 idle-teardown + PR #133 auto-resume behavior as seen from a mobile shell (lifecycle expectations).
- Place a 1024×1024 placeholder `src-tauri/icons/icon.png` and run `cargo tauri icon icon.png` so 12.4 inherits a working icon set on Day 1.

Then 12.4 proper (Mac host) and 12.5 (release CI) follow in their original order.

---

## Section 5 — Recommended PLAN.md edits

Since no PLAN.md exists in git, the action is **create** one (not edit), seeded
from this replan. Branch: `chore/phase-12-plan-mobile`.

Bullets the new `.planning/phases/12-mobile-tauri-client/PLAN.md` should contain:

- **Header note:** This plan was reconstructed 2026-05-28 from PR bodies after the original PLAN.md was never committed. Cite PR #105 / #110 / #111.
- **12.1 — DONE** (PR #105, commit `4bf69fa`): CORS, Tauri cookie variant, `POST /api/auth/finalize-mobile`, `.well-known/*`, `auth_handoff_tokens` table.
- **12.2 — DONE** (PR #110, commit `d639d56`): `web/src/lib/platform.ts`, `external-link.ts`, `push.ts`, safe-area CSS.
- **12.3 — DONE** (PR #111, commit `6696696`): `mobile/tauri/` scaffold pinned to supervisor Tauri 2.11.2, deep-link handler, CSP, `mobile-shell-typecheck.yml`.
- **12.3.1 — NEW** (proposed): Desktop preview + stale-doc sweep + icon placeholder. Owner: Windows box. No host blockers.
- **12.4 — REVISED scope:** (a) `gen/apple/` on a Mac, (b) `gen/android/` on an SDK+NDK host, (c) real `src-tauri/icons/icon.png` + fan-out, (d) code-signing onboarding (Apple Developer Program + Play upload key into GitHub repo secrets). **Remove** the `/api/auth/finalize-mobile` line — already shipped in 12.1.
- **12.5 — REVISED scope:** `.github/workflows/mobile-shell-release.yml` on `mobile-v*.*.*` tags. Matrix: `macos-latest` (iOS `.ipa` → TestFlight upload via `xcrun altool` or fastlane), `ubuntu-latest` (Android `.aab` → Play Console upload via `gradle-play-publisher`). **Drop** updater-key reuse from supervisor — stores own update delivery.
- **12.6 — REVISED scope:** Lockstep version bump across `mobile/tauri/src-tauri/Cargo.toml` + `tauri.conf.json` + `ui/package.json` + Cargo.lock. Tag `mobile-v0.2.0`. **Replace** Coolify `/health` poll with TestFlight build appearing in App Store Connect + Play Internal Testing track verification.
- **Cross-cutting invariants to add:**
  - Mobile shell must NOT touch `/ws/agent`; only `/ws/client` over the hosted SPA.
  - Mobile shell follows the supervisor-Tauri version pin lockstep (currently `tauri 2.11.2`).
  - Mobile shell does not embed any hub secrets; all auth is opaque-cookie via the finalize-mobile handoff.
  - Lifecycle assumption: foreground = WS connected, ≥5min background = supervisor may have killed runner, foreground resume = rely on PR #133 auto-resume.
  - License-expired UX must surface from both HTTP 402 AND `/ws/client` `subscribe_error: license_inactive` shape (PR #104).
