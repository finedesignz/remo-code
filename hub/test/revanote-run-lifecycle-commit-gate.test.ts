/**
 * finalizeAnnotationReply — proves resolved=true is downgraded unless the
 * cited commit_sha is verified on the GitHub remote (commit-verify.ts).
 * Incident: 43 Lakeside annotations closed `resolved` citing an unpushed/
 * dangling commit hash. See docs/revanote.md "Resolved requires a pushed
 * commit".
 *
 * DAL + ws registry + callback + commit-verify are mocked — no Postgres, no
 * live WS, no real GitHub network call.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

const state = {
  runPatches: [] as any[],
  statusCalls: [] as any[],
  broadcasts: [] as any[],
  callbacks: [] as any[],
  annPayloadRaw: {} as Record<string, any>,
}

function resetState() {
  state.runPatches = []
  state.statusCalls = []
  state.broadcasts = []
  state.callbacks = []
  state.annPayloadRaw = {}
}

mock.module('../src/db/revanote-dal.ts', () => ({
  updateAnnotationRun: async (id: string, patch: any) => {
    state.runPatches.push({ id, patch })
  },
  updateAnnotationStatus: async (id: string, status: string, opts: any = {}) => {
    state.statusCalls.push({ id, status, opts })
  },
  getAnnotationById: async (id: string) => ({
    id,
    annotation_id_external: 'ext-abc',
    user_id: 'user-1',
    callback_url: 'https://revanote.app/cb',
    payload_raw: state.annPayloadRaw,
  }),
}))

mock.module('../src/ws/registry.ts', () => ({
  broadcastRevanoteEvent: (_uid: string, ev: any) => state.broadcasts.push(ev),
}))

mock.module('../src/revanote/callback.ts', () => ({
  scheduleImmediateCallback: async (ann: any, payload: any) => {
    state.callbacks.push({ ann, payload })
  },
}))

let verifyBehavior: { verified: boolean; reason: string | null } = { verified: true, reason: null }
mock.module('../src/revanote/commit-verify.ts', () => ({
  verifyCommitOnRemote: async () => verifyBehavior,
}))

const { finalizeAnnotationReply } = await import('../src/revanote/run-lifecycle.ts')

function envelope(obj: Record<string, unknown>): string {
  return `Did the fix.\n<<JSON>>\n${JSON.stringify(obj)}\n<<END>>`
}

describe('finalizeAnnotationReply — commit verify gate', () => {
  beforeEach(() => {
    resetState()
    state.annPayloadRaw = { installation_id: 999, repo_slug: 'owner/repo' }
  })

  test('resolved:true with an unpushed/unverifiable SHA is downgraded to resolved:false', async () => {
    verifyBehavior = { verified: false, reason: 'commit_not_on_remote' }
    await finalizeAnnotationReply({
      sessionId: 'sess-1',
      runId: 'run-1',
      annotationId: 'ann-1',
      userId: 'user-1',
      startedAt: Date.now(),
      content: envelope({ resolved: true, action_taken: 'fixed it', files_changed: ['a.tsx'], commit_sha: 'dangling-sha' }),
    })

    expect(state.runPatches[0].patch.resolved).toBe(false)
    expect(state.statusCalls[0].status).toBe('failed')
    expect(state.statusCalls[0].opts.skip_reason).toBe('commit_not_on_remote')
    expect(state.callbacks[0].payload.resolved).toBe(false)
    expect(state.callbacks[0].payload.error).toBe('commit_not_on_remote')
  })

  test('resolved:true with no commit_sha at all is downgraded (commit_sha_missing)', async () => {
    verifyBehavior = { verified: false, reason: 'commit_sha_missing' }
    await finalizeAnnotationReply({
      sessionId: 'sess-1',
      runId: 'run-1',
      annotationId: 'ann-1',
      userId: 'user-1',
      startedAt: Date.now(),
      content: envelope({ resolved: true, action_taken: 'fixed it', files_changed: ['a.tsx'] }),
    })

    expect(state.runPatches[0].patch.resolved).toBe(false)
    expect(state.statusCalls[0].status).toBe('failed')
    expect(state.statusCalls[0].opts.skip_reason).toBe('commit_sha_missing')
    expect(state.callbacks[0].payload.resolved).toBe(false)
  })

  test('resolved:true with a verified SHA (mocked 200) is forwarded as resolved', async () => {
    verifyBehavior = { verified: true, reason: null }
    await finalizeAnnotationReply({
      sessionId: 'sess-1',
      runId: 'run-1',
      annotationId: 'ann-1',
      userId: 'user-1',
      startedAt: Date.now(),
      content: envelope({ resolved: true, action_taken: 'fixed it', files_changed: ['a.tsx'], commit_sha: 'realsha123' }),
    })

    expect(state.runPatches[0].patch.resolved).toBe(true)
    expect(state.statusCalls[0].status).toBe('resolved')
    expect(state.statusCalls[0].opts.skip_reason).toBeNull()
    expect(state.callbacks[0].payload.resolved).toBe(true)
    expect(state.callbacks[0].payload.error).toBeNull()
    expect(state.callbacks[0].payload.commit_sha).toBe('realsha123')
  })

  test('resolved:false replies are never routed through the commit gate', async () => {
    verifyBehavior = { verified: false, reason: 'commit_sha_missing' } // would fail if ever called
    await finalizeAnnotationReply({
      sessionId: 'sess-1',
      runId: 'run-1',
      annotationId: 'ann-1',
      userId: 'user-1',
      startedAt: Date.now(),
      content: envelope({ resolved: false, action_taken: '', files_changed: [], needs_clarification: true, clarification_question: 'which page?' }),
    })

    expect(state.runPatches[0].patch.resolved).toBe(false)
    expect(state.statusCalls[0].status).toBe('failed')
    // Untouched by the gate — original agent_unresolved-style reason, not a commit-verify reason.
    expect(state.statusCalls[0].opts.skip_reason).not.toBe('commit_not_on_remote')
    expect(state.statusCalls[0].opts.skip_reason).not.toBe('commit_sha_missing')
  })
})
