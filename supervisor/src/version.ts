/**
 * Single source of truth for the supervisor version reported to the hub in
 * `supervisor.hello` (and used in the self-Sentry client string).
 *
 * The version is imported directly from the authoritative manifest
 * (`tauri.conf.json`). Bun inlines JSON imports at `bun build --compile` time, so
 * the value is baked into the compiled sidecar binary; under `bun run` (dev) the
 * same import reads the live file. Either way the reported version always equals
 * the MSI/manifest version — no compile-time `--define`, no hand-maintained
 * fallback constant, and therefore nothing that can silently drift.
 *
 * History (RCA 2026-05-28): the version used to be a hand-maintained constant
 * duplicated across files; it drifted from the manifests and the web UI showed a
 * stale version forever. A `--define`-injected env var + a `FALLBACK_VERSION`
 * constant fixed the compiled path but reintroduced a second copy that drifted
 * again at the 0.11.1 release. Importing the manifest removes the second copy
 * entirely.
 *
 * Lockstep manifests still verified by supervisor/test/version-drift.test.ts:
 *   - supervisor/tauri/src-tauri/tauri.conf.json  (authoritative, imported here)
 *   - supervisor/tauri/src-tauri/Cargo.toml
 *   - supervisor/tauri/ui/package.json
 */
import tauriConf from '../tauri/src-tauri/tauri.conf.json'

/** The version reported at runtime, sourced from tauri.conf.json. */
export const VERSION: string = tauriConf.version
