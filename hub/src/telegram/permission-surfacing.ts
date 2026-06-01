/**
 * Phase 20 plan 03 — fail-closed permission surfacing (placeholder seam).
 *
 * Plan 02 wires the bridge to call start/stopPermissionSurfacing per session.
 * Plan 03 implements the body: attach a consumer to the session's transcript
 * source that runs the fail-closed detector and surfaces pendings via the
 * existing inline approvals UX. Until then these are inert no-ops so the bridge
 * compiles + runs on the transcript-tail without surfacing permissions.
 */

export async function startPermissionSurfacing(_sessionId: string): Promise<void> {
  // Implemented in plan 03.
}

export function stopPermissionSurfacing(_sessionId: string): void {
  // Implemented in plan 03.
}
