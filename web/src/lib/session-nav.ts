/**
 * Resolving a freshly-started supervisor run to its session id.
 *
 * `POST /api/supervisors/:id/start` answers with a `run_id` only — the hub
 * reserves the run slot with `session_id: null` and binds the real session id
 * later, once the supervisor has launched the CLI and authenticated. So the
 * Play button can't navigate straight to a session: it has to wait for the bind.
 */

export interface RunSessionBinding {
  id: string;
  session_id?: string | null;
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Aborts the wait (unmount / navigation). Resolves null. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `fetchRuns` until the run with `runId` reports a non-null `session_id`.
 * Returns that id, or null if the run never binds one within `timeoutMs`, the
 * run disappears from the active list, or the wait is aborted. A null return
 * means "do not navigate" — there is no session to navigate to.
 */
export async function waitForRunSessionId(
  fetchRuns: () => Promise<RunSessionBinding[]>,
  runId: string,
  opts: WaitOptions = {},
): Promise<string | null> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (!opts.signal?.aborted) {
    let runs: RunSessionBinding[] = [];
    try {
      runs = await fetchRuns();
    } catch {
      // Transient fetch failure — keep polling until the deadline.
    }
    if (opts.signal?.aborted) return null;

    const run = runs.find((r) => r.id === runId);
    if (run?.session_id) return run.session_id;
    // The run ended before binding a session (crash / immediate exit): the
    // hub drops it from the active list, so there is nothing left to wait for.
    if (runs.length > 0 && !run) return null;

    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
  return null;
}
