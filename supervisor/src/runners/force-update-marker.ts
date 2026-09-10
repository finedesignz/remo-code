import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { supervisorStateDir } from './session-breadcrumb'

/**
 * milestone remote-update-trigger — the sidecar's half of the hub→sidecar→tray
 * force-update chain. `supervisor.force_update` (hub → sidecar) writes this
 * marker; the Rust tray watcher (`auto_update.rs`) polls it every ~20s,
 * deletes it BEFORE running the update (so a relaunched post-install sidecar
 * can never re-trigger off the same marker), then calls the existing
 * `run_check`. This module only writes the marker — it never runs the update
 * itself, since the sidecar has no updater.
 */

export interface ForceUpdateMarker {
  requested_at: string
  requested_by?: string
}

export function forceUpdateMarkerPath(): string {
  return join(supervisorStateDir(), 'force-update.json')
}

/** Returns the path written, or null on any failure (caller reports ok:false). */
export function writeForceUpdateMarker(requestedBy: string | undefined, now: Date = new Date()): string | null {
  try {
    const dir = supervisorStateDir()
    mkdirSync(dir, { recursive: true })
    const marker: ForceUpdateMarker = {
      requested_at: now.toISOString(),
      ...(requestedBy ? { requested_by: requestedBy } : {}),
    }
    const path = forceUpdateMarkerPath()
    writeFileSync(path, JSON.stringify(marker, null, 2) + '\n')
    return path
  } catch {
    return null
  }
}
