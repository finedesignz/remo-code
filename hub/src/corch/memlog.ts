// hub/src/corch/memlog.ts
//
// CORCH-09 (R3.8): the memlog claim seam. Before CORCH touches a worktree it must hold a memlog claim
// `{repo, session: corch:<work_item_id>, branch: corch/<work_item_id>, worktree, scope}` taken by hub SERVER code
// (a prompt is not a control). The claim is heartbeated from the run heartbeat and released when the item is done,
// blocked or cancelled.
//
// TRANSPORT (A7, verified in phase research, see RESEARCH.md): memlog is an MCP Factory server reachable only
// through the gateway with a gateway token (mcp-servers apps/memlog, gateway-only tools). The hub holds no
// gateway credential and has no MCP client, so NO verified hub->memlog transport exists. Per the 7e rule no
// workaround transport is built here: the default client REFUSES `memlog_unavailable`, so with the flag ON an
// item waits (no dispatch without a claim) until an mcp-servers endpoint the hub can call exists and a real
// `MemlogClient` is injected. R3.8 is BLOCKED-ON-MCP; everything else is complete and proven with a fake client.
//
// No import of the DB client, ws/* or any transport: this module is pure types plus the refusing default.

export type MemlogClaimInput = {
  repo: string
  session: string
  branch: string
  worktree: string
  scope: string
}

export type MemlogClaimResult =
  | { ok: true }
  /** A different live session holds a claim on this branch or worktree. The item waits, no attempt consumed. */
  | { ok: false; reason: 'memlog_conflict' }
  /** The claim could not be taken or confirmed (transport down, unconfigured, error). Fail closed. */
  | { ok: false; reason: 'memlog_unavailable' }

export interface MemlogClient {
  claim(i: MemlogClaimInput): Promise<MemlogClaimResult>
  /** Best effort; returns false when the heartbeat was not recorded. Never throws into the caller. */
  heartbeat(i: { repo: string; session: string }): Promise<boolean>
  /** Best effort; returns false when the release was not recorded. */
  release(i: { repo: string; session: string; status: 'DONE' | 'ORPHANED'; note: string }): Promise<boolean>
}

/** The fail-closed default: no transport exists, so no claim can be taken and nothing dispatches. */
export const DEFAULT_MEMLOG: MemlogClient = {
  claim: async () => ({ ok: false, reason: 'memlog_unavailable' }),
  heartbeat: async () => false,
  release: async () => false,
}

/** The memlog session identity of a work item. */
export const memlogSessionFor = (workItemId: string): string => `corch:${workItemId}`
