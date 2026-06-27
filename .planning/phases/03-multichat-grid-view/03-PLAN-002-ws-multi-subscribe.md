---
plan_id: 03-PLAN-002-ws-multi-subscribe
wave: 1
depends_on: []
files_modified:
  - hub/src/ws/protocol.ts
  - hub/src/ws/client.ts
  - hub/src/ws/registry.ts
  - hub/test/ws-multi-subscribe.test.ts
  - web/src/hooks/useWebSocket.ts
autonomous: true
requirements: [R05, R10]
---

# Plan 03-002 — WS multi-subscribe (overload, do NOT add new op)

<tasks>

<task id="T1">
<action>Edit `hub/src/ws/protocol.ts`: change `ClientSubscribe` to OVERLOAD the existing `subscribe` op — accept BOTH `session_id?: string` (legacy single) AND `session_ids?: string[]` (multi). Schema: `z.object({ type: z.literal('subscribe'), session_id: z.string().min(1).max(256).optional(), session_ids: z.array(z.string().min(1)).max(12).optional() }).refine(d => !!d.session_id || (d.session_ids && d.session_ids.length > 0), { message: 'subscribe requires session_id or session_ids' })`. The cap is now 12 (was 100). Add a new `HubToClient` variant: `{ type: 'subscribe_error', error: 'too_many_sessions' | 'invalid_subscribe', max?: number }`. Add the variant to the discriminated-union return type if one exists; otherwise add to the union of message types the web client knows about. DO NOT add a `subscribe_many` op — overload is the contract.</action>
<read_first>
- hub/src/ws/protocol.ts (whole file — current ClientSubscribe shape and the HubToClient type)
- .planning/codebase/CONVENTIONS.md (WebSocket Protocol & Zod Validation section)
</read_first>
<acceptance_criteria>
- `ClientSubscribe.parse({ type: 'subscribe', session_id: 'a' })` succeeds (back-compat)
- `ClientSubscribe.parse({ type: 'subscribe', session_ids: ['a','b','c'] })` succeeds
- `ClientSubscribe.parse({ type: 'subscribe', session_ids: Array(13).fill('x') })` fails (cap = 12)
- `ClientSubscribe.parse({ type: 'subscribe' })` fails (refine error)
- The new `subscribe_error` shape is exported and used in the union
</acceptance_criteria>
</task>

<task id="T2">
<action>Edit `hub/src/ws/client.ts`: extend the per-connection state object to include `subscribed: Set<string>`. On a `subscribe` message: if `session_id` present, treat as `session_ids: [session_id]`; verify EVERY id in the array belongs to the authenticated user via DAL (`getSessionOwner(sessionId)` or equivalent) — if any id is not owned, send `{ type: 'subscribe_error', error: 'invalid_subscribe' }` and ignore the call. If `state.subscribed.size + new_ids.length > 12`, send `{ type: 'subscribe_error', error: 'too_many_sessions', max: 12 }` and ignore. Otherwise, add all ids to `state.subscribed`. The subscribe op REPLACES the set (do not accumulate across calls) — the client sends the full active set on every change.</action>
<read_first>
- hub/src/ws/client.ts (entire file — current subscribe handler, state shape)
- hub/src/db/dal.ts (find or add `getSessionOwner(sessionId): Promise<string | null>`)
</read_first>
<acceptance_criteria>
- A subscribe call with one foreign session_id triggers a `subscribe_error` and the connection's `subscribed` set is unchanged
- Two subscribe calls in a row REPLACE rather than UNION the set (last-write-wins)
- A subscribe call that would push size > 12 is rejected with `too_many_sessions`
- Legacy single-`session_id` subscribe still works end-to-end
</acceptance_criteria>
</task>

<task id="T3">
<action>Edit `hub/src/ws/registry.ts` (and any broadcast helper called from `hub/src/ws/agent.ts`): change `broadcastToSubscribers(sessionId, message)` (or equivalent) to iterate connections and deliver only when `conn.state.subscribed.has(sessionId)`. If the helper currently uses a `Map<sessionId, Set<conn>>`, update it to maintain that map as a derived index of the per-connection sets — write/remove entries on subscribe / unsubscribe / disconnect. Either implementation is acceptable; the contract is "events for session X only reach connections whose subscribed set contains X".</action>
<read_first>
- hub/src/ws/registry.ts (whole file — current registry shape)
- hub/src/ws/agent.ts (find every `broadcast` call site to ensure all activity events use the same helper)
</read_first>
<acceptance_criteria>
- Every broadcast call site in `hub/src/ws/agent.ts` goes through the registry helper (no direct iteration over a flat connection list)
- Disconnecting a client removes its membership from any derived index (no leaked refs)
- `grep -nE "broadcast|deliver" hub/src/ws/registry.ts` shows the membership-check predicate
</acceptance_criteria>
</task>

<task id="T4">
<action>Write `hub/test/ws-multi-subscribe.test.ts` (Bun test, env-gated like the e2e). Cases: (a) authenticate, subscribe to `['s1','s2','s3']`, simulate hub-side activity events for s1/s2/s3/s4, assert events for s1/s2/s3 arrive and s4 does NOT; (b) re-subscribe to `['s4']` only, assert subsequent s1 events are no longer delivered; (c) subscribe with 13 ids returns `subscribe_error` with `max: 12`; (d) subscribe including a foreign session returns `subscribe_error` and original set unchanged; (e) legacy `subscribe { session_id }` still delivers events for that one session.</action>
<read_first>
- hub/test/scheduled-tasks.e2e.test.ts (WS client harness pattern)
- hub/src/ws/client.ts (final shape after T2)
</read_first>
<acceptance_criteria>
- All 5 cases pass with `REMO_E2E_DB_URL` set; cleanly skip without
- The "no leakage to non-subscribers" assertion is explicit: receive on a separate connection that did NOT subscribe to s1, send an s1 event, assert nothing arrives within 500ms
</acceptance_criteria>
</task>

<task id="T5">
<action>Edit `web/src/hooks/useWebSocket.ts` (or whichever hook owns the subscribe call — verify with grep): change the subscribe API to accept `string | string[]` and send `{ type: 'subscribe', session_ids: ids }` when given an array. Existing single-session call sites continue to pass a string — keep them working unchanged. Add typed handling for the inbound `subscribe_error` message: surface it via a callback / store entry so `<GridPage>` can show a non-blocking toast in PLAN-004. Do NOT auto-retry on `subscribe_error`; let the caller decide.</action>
<read_first>
- web/src/hooks/useWebSocket.ts
- web/src/hooks/useChat.ts (or equivalent that today calls subscribe)
- web/src/components/Layout.tsx (the current single-session subscribe driver)
</read_first>
<acceptance_criteria>
- Calling `subscribe(['a','b','c'])` sends a single `{ type: 'subscribe', session_ids: ['a','b','c'] }` frame (verified in browser devtools or a test stub)
- Calling `subscribe('x')` sends `{ type: 'subscribe', session_id: 'x' }` (back-compat)
- `subscribe_error` messages are NOT silently swallowed — they reach a listener
- Existing `#/chat` view continues to work with no visible change
</acceptance_criteria>
</task>

</tasks>

must_haves:
- The `subscribe` op is OVERLOADED, not replaced; no new op was added
- Per-connection cap is 12; over-cap subscribes are rejected with a typed error
- Activity events route via per-connection set membership; no event leaks to non-subscribers
- The web hook accepts both `string` and `string[]` without breaking the existing single-chat call site
- A focused Bun test asserts the no-leakage invariant explicitly
