// hub/src/heal/sinks/coolify.ts
//
// PTYCAP-07-07 (D-07, AM-F5-3): Coolify deploy-failure sink. The dispatch run is a CHILD row under
// the internal triage task whose triggered_by_run_id is the Coolify metadata (trigger) run; the
// terminal status is mirrored onto the metadata run so neither row can sit pending. Every
// terminal write is a conditional only_if_active finalize and each run is written at most once.

import type { HealEvent } from '../types.ts';
import { parseTriageOutput } from '../../scheduler/triage-schema.ts';
import { sendUserMessage, type SendDeps } from './shared.ts';
import type { HealSink, HealTerminalOutcome, SinkContext } from './types.ts';

type RunStatusLike = 'success' | 'failed' | 'skipped' | 'skipped_quota';

export interface CoolifyDeps {
  ensureInternalTriageTask(userId: string): Promise<string>;
  insertRun(input: {
    task_id: string;
    user_id: string;
    status: 'pending';
    scheduled_for: Date;
    target_kind: 'session';
    target_id: null;
    triggered_by_run_id: string | null;
  }): Promise<{ id: string }>;
  trackRun(ctx: {
    runId: string;
    taskId: string;
    userId: string;
    target: { kind: 'session'; sessionId: null; online: true };
    startedAt: number;
    parentFireId: null;
    chainDepth: number;
    triggeredByRunId: string | null;
  }): unknown;
  broadcastRunStarted?(userId: string, payload: object): unknown;
  finalizeRun(
    runId: string,
    status: RunStatusLike,
    error: string | null,
    fields: { duration_ms?: number | null; output_snippet?: string | null; only_if_active: true },
  ): Promise<void>;
  removeRunContext(runId: string): unknown;
  send?: SendDeps;
  now(): number;
}

export const REAL_COOLIFY_DEPS: CoolifyDeps = {
  ensureInternalTriageTask: async (userId) => (await import('../../db/dal.ts')).ensureInternalTriageTask(userId),
  insertRun: async (input) => (await import('../../db/scheduled-tasks-dal.ts')).insertRunV2(input),
  trackRun: async (ctx) => (await import('../../scheduler/dispatcher.ts')).trackRun(ctx),
  broadcastRunStarted: async (userId, payload) => (await import('../../ws/registry.ts')).broadcastScheduledRun(userId, payload),
  finalizeRun: async (runId, status, error, fields) => (await import('../../scheduler/dispatcher.ts')).finalizeRun(runId, status, error, fields),
  removeRunContext: async (runId) => (await import('../../scheduler/dispatcher.ts')).removeRunContext(runId),
  now: () => Date.now(),
};

export function buildCoolifySink(event: HealEvent, _ctx: SinkContext, deps: CoolifyDeps = REAL_COOLIFY_DEPS): HealSink {
  let childRunId: string | null = null;
  let startedAt = deps.now();
  const written = new Set<string>();

  /** First writer wins; a run is never written twice by this sink. */
  const writeOnce = async (
    runId: string,
    status: RunStatusLike,
    error: string | null,
    fields: { duration_ms?: number | null; output_snippet?: string | null } = {},
  ) => {
    if (written.has(runId)) return;
    written.add(runId);
    try {
      await deps.finalizeRun(runId, status, error, { ...fields, only_if_active: true });
    } catch (err) {
      written.delete(runId);
      throw err;
    }
  };

  /** Terminalize the child (when one exists) and mirror the status onto the metadata run. */
  const finish = async (
    status: RunStatusLike,
    error: string | null,
    childFields: { duration_ms?: number | null; output_snippet?: string | null } = {},
  ) => {
    if (childRunId) {
      await writeOnce(childRunId, status, error, childFields);
      await deps.removeRunContext(childRunId);
    }
    if (event.metadata_run_id) await writeOnce(event.metadata_run_id, status, error);
  };

  return {
    async open() {
      const taskId = await deps.ensureInternalTriageTask(event.user_id);
      const now = new Date(deps.now());
      const run = await deps.insertRun({
        task_id: taskId,
        user_id: event.user_id,
        status: 'pending',
        scheduled_for: now,
        target_kind: 'session',
        target_id: null,
        triggered_by_run_id: event.trigger_run_id,
      });
      childRunId = run.id;
      startedAt = now.getTime();
      await deps.trackRun({
        runId: run.id,
        taskId,
        userId: event.user_id,
        target: { kind: 'session', sessionId: null, online: true },
        startedAt,
        parentFireId: null,
        chainDepth: 0,
        triggeredByRunId: event.trigger_run_id,
      });
      await deps.broadcastRunStarted?.(event.user_id, {
        type: 'scheduled_run_started',
        run_id: run.id,
        task_id: taskId,
        scheduled_for: now.toISOString(),
        target_kind: 'session',
        target_id: null,
      });
      return run.id;
    },
    async markSkipped(_token, reason) {
      await finish(reason.startsWith('quota_threshold_reached') ? 'skipped_quota' : 'skipped', reason);
    },
    async onFinalize(_token, content) {
      const duration = deps.now() - startedAt;
      const parsed = parseTriageOutput(content);
      if (parsed.ok) {
        await finish('success', null, { duration_ms: duration, output_snippet: JSON.stringify(parsed.value) });
      } else {
        await finish('failed', 'triage_parse_error', {
          duration_ms: duration,
          output_snippet: content.length > 4000 ? content.slice(0, 4000) : content,
        });
      }
    },
    async markFailed(_token, errMsg) {
      await finish('failed', `agent_send_failed: ${errMsg}`);
    },
    send: (req) =>
      sendUserMessage(
        req,
        { storedContent: event.stored_content, runId: childRunId ?? undefined, broadcast: true, offlineError: 'agent_socket_missing' },
        deps.send,
      ),
    async finalizeTerminal(outcome: HealTerminalOutcome) {
      switch (outcome.kind) {
        case 'no_routable_session':
          return finish('skipped', 'no_routable_session');
        case 'refused':
          return finish('skipped', outcome.reason);
        case 'deduped':
          return finish('skipped', 'deduped');
        case 'failed':
          return finish('failed', outcome.reason);
      }
    },
    async onParkExpire() {
      await finish('failed', 'agent_socket_missing');
    },
  };
}
