/**
 * Single source of truth for the supervisor version that is reported to the
 * hub in `supervisor.hello` (and used in the self-Sentry client string).
 *
 * Why this module exists (RCA 2026-05-28):
 *   The version was previously a hand-maintained `const VERSION = '0.5.8'`
 *   duplicated in `hub-client.ts` and `index.ts`. It silently drifted from the
 *   real installed version (`tauri.conf.json` / `Cargo.toml` were at 0.6.3)
 *   because the compiled `bun build --compile` sidecar bakes in whatever
 *   string the source held, regardless of the Tauri/Cargo manifests. The web
 *   UI then showed the stale 0.5.8 forever, even after a user restart.
 *
 * Single-source mechanism:
 *   - At build time the release workflow injects the authoritative version from
 *     `tauri.conf.json` via Bun's `--define` flag:
 *         bun build --compile --define 'process.env.REMO_SUPERVISOR_VERSION="<v>"' ...
 *     so the compiled sidecar carries the manifest version, not this fallback.
 *   - `FALLBACK_VERSION` below is the dev/uncompiled value AND the value the
 *     drift guard (`supervisor/test/version-drift.test.ts`) asserts equals
 *     `tauri.conf.json`'s `version`. So even the fallback can never silently
 *     drift again — the test fails the build if it does.
 *
 * Keep `FALLBACK_VERSION` in lockstep with:
 *   - supervisor/tauri/src-tauri/tauri.conf.json  (authoritative)
 *   - supervisor/tauri/src-tauri/Cargo.toml
 *   - supervisor/tauri/ui/package.json
 */

/**
 * Hard-coded fallback — must equal the `version` in tauri.conf.json. Enforced
 * by supervisor/test/version-drift.test.ts. Bump in lockstep on every release.
 */
export const FALLBACK_VERSION = '0.9.0'

/**
 * The version reported at runtime. Prefers the build-time-injected
 * `REMO_SUPERVISOR_VERSION` (set from tauri.conf.json during compile); falls
 * back to `FALLBACK_VERSION` for `bun run`/dev where no define is present.
 */
export const VERSION: string =
  (typeof process !== 'undefined' && process.env?.REMO_SUPERVISOR_VERSION) || FALLBACK_VERSION
