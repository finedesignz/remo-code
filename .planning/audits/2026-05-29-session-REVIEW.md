---
review: 2026-05-29 session (PRs #176–#183)
reviewed_at: 2026-05-29
depth: deep
diff_base: 53abf8c..HEAD (1cc8e76)
files_reviewed: 24
findings:
  critical: 0
  warning: 6
  info: 7
  total: 13
status: issues_found
verdict: SHIP with follow-ups — no Critical/blocker. The auth-hardening render gate is sound (no infinite loop). Warnings are robustness/correctness papercuts, none data-loss or security-breaking.
---

# Code Review — 2026-05-29 Session (PRs #176–#183)

## Summary

Reviewed the merged diff `53abf8c..HEAD` across 24 source files: Telegram
orchestrator-default + pagination (#176), nav/sidebar active-only restructure
(#177), Toggle/connections tokens (#178/#179), auth-hardening render gate
(#180–#182), and the OrchestratorTab + ProfileTab Telegram card (#183).

**Headline: the auth-hardening change is correct.** I traced every loop concern
the brief flagged and none holds:

- `signOut` is `useCallback([])`-stable → it does NOT change identity per render,
  so the dead-credential effect deps `[profileLoading, profile, token, user, signOut]`
  cannot churn from `signOut`.
- The dead-credential effect (`App.tsx:156`) is self-terminating: `signOut`
  clears `token`+`user` synchronously → `(token || user)` is false on the next
  render → effect no-ops. **No infinite loop.**
- `apiLogout()` (`auth.ts:66`) uses a bare `fetch`, NOT `hubFetch`, so the
  logout call cannot re-fire `authEventHandler` and cannot start a signOut storm.
- The `route === 'login'` guard + `!token||!user` gate + `!profile` gate are
  layered correctly; a dead session deterministically lands on `<Login>`, never
  a blank `<WebSocketProvider>`.

`useSessions` non-array coercion (`Array.isArray(data)?data:[]`) plus the
belt-and-suspenders guards in `connectedSessions`, `SupervisorPage` `for…of`,
and `ProfileTab` `safeSessions` close the non-array crash class cleanly.

Telegram pagination/orchestrator-filter: `parseCallbackData` bounds are tight,
`safeEditMessageText` has a correct re-send fallback, `answerCallbackQuery` fires
on every branch, constant-time secret compare untouched, schema.sql has NO data
mutation. DAL SQL is fully parameterized.

No Critical findings. 6 Warnings, 7 Info.

---

## Critical Issues

None. The section the brief told me to scrutinize hardest (App.tsx auth effects)
is clean — see Summary for the loop/storm trace.

---

## Warnings

### WR-01: Concurrent 401s fire redundant `signOut()` + duplicate logout POSTs (no loop, but noisy)

**File:** `web/src/App.tsx:127-146`, `web/src/hooks/useAuth.ts:57-64`

**Problem:** On a dead credential, every in-flight `hubFetch` that 401s calls
`authEventHandler('unauthorized')` → `signOut()`. Multiple hooks (`useProfile`,
`useSessions`, `useLicense`, WS reconnect, any open page tab fetch) fire
concurrently, so `signOut()` runs N times before `route` flips to `login` (the
guard `route !== 'login'` only suppresses *after* the async hashchange settles).
Each call invokes `apiLogout()` → N redundant `POST /api/auth/logout`.

**Why it matters:** Not a loop and not data loss — bounded by concurrent request
count. But it spams the logout endpoint and runs `clearAuth()`/`setState` N times.
Under a tab with grid + sidebar + supervisor page all mounted it could be 5–10
duplicate logouts per dead-credential event.

**Fix:** Add an in-module `signingOut` latch in `App.tsx` (or in `signOut`):
```ts
const signingOut = useRef(false)
// in handler:
if (kind === 'unauthorized' && !signingOut.current
    && route !== 'login' && route !== 'auth-callback') {
  signingOut.current = true
  signOut()
}
```
Or de-dupe inside `apiLogout` with a module-level `let logoutInFlight: Promise<void> | null`.

### WR-02: `clearTelegramChatId` leaves `telegram_default_explicit` stale-true after unlink

**File:** `hub/src/db/dal.ts:1662-1669`

**Problem:** Unlink nulls `telegram_chat_id` + `telegram_default_session_id` but
does NOT reset `telegram_default_explicit`. A user who explicitly picked a
session (flag=true), then unlinks, then re-links, carries `explicit=true` with a
null default into the new link.

**Why it matters:** Latent, currently masked: in `dispatchInbound`
(`telegram-webhook.ts:273`) the gate is `if (!targetSessionId || !defaultIsExplicit)`,
and `targetSessionId` is null after unlink, so the orchestrator fallback still
fires. It is only harmless because the null short-circuits first. Any future
code that reads `telegram_default_explicit` independently of the session id will
misbehave. Reset it now while the contract is fresh.

**Fix:**
```sql
UPDATE users
   SET telegram_chat_id = NULL,
       telegram_default_session_id = NULL,
       telegram_default_explicit = false
 WHERE id = ${userId}
```

### WR-03: `window.open(r.deepLink, "_blank")` without `noopener` — reverse-tabnabbing surface

**File:** `web/src/pages/settings/ProfileTab.tsx:436`

**Problem:** `window.open(r.deepLink, "_blank")` opens a server-provided URL
without `noopener,noreferrer`. The opened tab gets a live `window.opener`
reference back into the SPA origin.

**Why it matters:** The `deepLink` is hub-built as
`https://t.me/${botUsername}?start=${code}` from the admin-controlled
`config.telegram.botUsername` env (`telegram.ts:83`), so this is NOT an
attacker-injected-URL XSS today — `t.me` is the only destination. But `_blank`
without `noopener` is an unconditional reverse-tabnabbing footgun, and it trusts
the server response shape blindly. Low real-world risk, trivial fix.

**Fix:**
```ts
if (r.deepLink) window.open(r.deepLink, "_blank", "noopener,noreferrer");
```
Optionally assert the prefix: `if (r.deepLink?.startsWith('https://t.me/')) …`.

### WR-04: `TelegramCard.refresh()` / `useEffect([])` can `setState` after unmount

**File:** `web/src/pages/settings/ProfileTab.tsx:413-424`

**Problem:** `useEffect(() => { void refresh(); }, [])` fires an async
`hubFetch('/api/telegram/status')`; if the user switches settings tab before it
resolves, `setStatus`/`setError`/`setLoading` run on an unmounted component. Same
pattern in `OrchestratorTab.tsx:41` (`refresh()` on mount) and its `patch/start/stop`.

**Why it matters:** React 18 swallows the warning, but a slow `/status` followed
by a fast tab-swap leaks a state write and (with `savedFlash`/`setTimeout`
timers in OrchestratorTab) a dangling timer. Not a crash; it is a real
unmount-safety gap repeated across the new tabs.

**Fix:** Track a cancelled flag:
```ts
useEffect(() => {
  let alive = true;
  (async () => { const r = await hubFetch(...); if (alive) setStatus(r); })();
  return () => { alive = false };
}, []);
```
Or use an `AbortController` and bail on `aborted`.

### WR-05: `OrchestratorTab` start/stop set no error state on partial failure and `refresh()` swallows reload errors silently

**File:** `web/src/pages/settings/OrchestratorTab.tsx:58-80, 30-39`

**Problem:** `start()`/`stop()` call `await hubFetch(...)` then `await refresh()`.
If the POST succeeds but `refresh()` throws (e.g. transient 500), the error is
caught only inside `refresh()` and shown via `setErr`, but the `start/stop`
`catch` never runs, so `busy` is cleared by `finally` while the UI shows a stale
snapshot with a generic "load failed" — the user can't tell the action actually
took. Also `refresh()` on initial mount has no `setBusy`/loading coupling, so a
failed first load shows the bare "Loading…" forever if `setErr` is the only
signal (it renders `err` but keeps `snap===null` → still "Loading…").

**Why it matters:** Confusing state on the orchestrator enable/disable path,
which is a destructive-ish, full-power-key action. A failed initial load is
indistinguishable from a slow one.

**Fix:** Render an explicit error/retry state when `snap===null && err`:
```tsx
{!snap && err ? <ErrorRetry msg={err} onRetry={refresh}/> : !snap ? <Loading/> : …}
```
and surface refresh failures inside start/stop as their own toast.

### WR-06: Sentinel-orchestrator picker rows are not bounded for the 200-row cap interaction

**File:** `hub/src/telegram/commands.ts:273-296`, `session-picker.ts:304-308`

**Problem:** `listUserSessionsForPicker` prepends a synthetic orchestrator row
when none survived the filter: `return [synthetic, ...filtered]`. The 200-row
cap is applied in the SQL `LIMIT` before this prepend, so a user at exactly the
cap gets 201 rows in the picker. `snapOffsetToPage` and `buildSessionKeyboard`
slice by `PAGE_SIZE`, so pagination still works, but `renderPickerText`'s
`"(${offset+1}–${lastIdx} of ${total})"` uses `total = rows.length` (201) while
the last page's `Next »` test (`offset + PAGE_SIZE < total`) is computed against
the same 201 — consistent, so no broken nav, but the count is off-by-one vs the
DB cap and the synthetic row participates in `findIndex`/offset math at
`telegram-webhook.ts:526` only for real ids (sentinel never matches → offset 0,
fine).

**Why it matters:** Cosmetic count drift + an unbounded-by-one list. Low
severity, but worth pinning the invariant: the synthetic row should count
against the cap, not on top of it.

**Fix:** Prepend then `.slice(0, 200)`, or document that the cap is 200 *real*
sessions and the synthetic is exempt. Tighten the comment in
`listUserSessionsForPicker` to state the post-prepend bound.

---

## Info

### IN-01: `console.log` mount/unmount debug artifacts left in tab modules

**File:** `web/src/pages/settings/ProfileTab.tsx:32-33`
**Problem:** `console.log("[tab:settings:profile] mounted")` / `unmounted`.
Ships to prod console. Other settings tabs (`CredentialsTab`, `PromptsTab`,
etc.) carry the same pattern per the diff. **Fix:** gate behind
`import.meta.env.DEV` or remove.

### IN-02: `useProfile.fetchProfile` early-returns without `setLoading(false)` on null token

**File:** `web/src/hooks/useProfile.ts:21-28`
**Problem:** `if (!token) return` leaves `loading=true` permanently when token is
null. Currently masked because `App` renders `<Login>` via the `!token||!user`
gate before consulting `profileLoading`. **Fix:** `if (!token) { setLoading(false); return }`
so the state is honest if a future caller reads `profileLoading` without the gate.

### IN-03: `getRoute()` runs `resolveHashWithRedirects()` (a side-effecting `replaceState`) inside `useState` initializer

**File:** `web/src/App.tsx:84, 107`
**Problem:** `useState<Route>(getRoute)` → `resolveHashWithRedirects()` mutates
history during render-phase initialization. React may invoke the initializer
twice under StrictMode; `replaceState` is idempotent here so it's safe, but
side-effects in a state initializer are an anti-pattern. **Fix:** resolve
redirects once in a top-level module statement (like the pathname normalize at
line 42) and have `getRoute` be pure.

### IN-04: Dead prop `_launchSession` retained in `Sidebar` Props

**File:** `web/src/components/Sidebar.tsx:45-48`
**Problem:** `launchSession: _launchSession` — kept in the destructure only to
swallow the still-passed prop now that offline rows are gone. Callers still pass
it. Fine for one release, but it is now dead surface. **Fix:** drop
`launchSession` from `Props` and the call sites when the active-only sidebar
settles; track as cleanup.

### IN-05: `renderPickerText` legend "🟢 = launched" always shown even when no row is launched

**File:** `hub/src/telegram/session-picker.ts:266`
**Problem:** `legend.push("🟢 = launched")` is unconditional; an all-offline
page shows a legend entry for a marker not present. Cosmetic. **Fix:** push only
when `page.some(isOnline)`.

### IN-06: `pickLargestPhoto` assumes non-empty array via `photos[0]!`

**File:** `hub/src/api/telegram-webhook.ts:158-159`
**Problem:** `let best = photos[0]!` non-null-asserts. Callers gate on
`msg.photo.length > 0` (lines 297, 750) so it's safe, but the `!` hides the
contract. **Fix:** the existing call-site guards are correct; add a
`if (photos.length === 0) throw` or accept the guard as the invariant — no
change strictly required.

### IN-07: `telegram_default_explicit` resolution comment-vs-code: lazy-pin writes false even when it becomes the de-facto only target

**File:** `hub/src/api/telegram-webhook.ts:273-287`
**Problem:** Design choice (documented): orchestrator fallback lazy-pins
`explicit=false`. This means every inbound for a no-explicit-choice user
re-resolves the orchestrator and re-writes the pin. The `setTelegramDefaultSession`
call is wrapped in try/catch and idempotent, so this is just a redundant UPDATE
per message until the user makes an explicit pick. **Fix:** skip the write when
`user.telegram_default_session_id === orch && user.telegram_default_explicit === false`
already — avoids a DB write on every Telegram message from orchestrator users.

---

## Section verdicts (clean callouts)

- **App.tsx auth render gate / effects:** CLEAN. No infinite loop, no signOut
  identity churn, no blank-screen path. (WR-01 is noise, not a loop.)
- **useSessions + consumers non-array guards:** CLEAN. Coercion at source +
  belt-and-suspenders at `connectedSessions`/`SupervisorPage`/`ProfileTab`.
- **schema.sql idempotency:** CLEAN. New column is `ADD COLUMN IF NOT EXISTS …
  DEFAULT false`; the data backfill was correctly moved to the one-shot script.
  No data-mutating statement in schema.sql.
- **dal.ts SQL:** CLEAN. All interpolations are postgres.js tagged-template
  params; no string concatenation, no injection.
- **Telegram callback_data bounds:** CLEAN. `parseCallbackData` length-checks
  (≤64, sid 1–60, offset 0–10000, `Number.isInteger`); `snapOffsetToPage`
  clamps to a valid page.
- **constant-time secret compare:** CLEAN, untouched (`timingSafeEqual` with
  length-prefix check).
- **answerCallbackQuery always fires:** CLEAN — every `handleCallbackQuery`
  branch calls `safeAnswerCallback`.
- **AppShell dropdown listeners:** CLEAN. `pointerdown`/`keydown`/`resize` all
  removed in the effect cleanup, gated on `open`/`navOpen`.

---

_Reviewed: 2026-05-29 · Reviewer: gsd-code-reviewer (deep) · base 53abf8c..1cc8e76_
