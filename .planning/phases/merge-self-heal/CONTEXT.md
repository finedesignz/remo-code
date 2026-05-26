# Phase: upstream-fixes-merge

> **Note (Phase 09, 2026-05-26):** This historical phase plan references the retired agent/ workspace and channel/ plugin. See .planning/phases/09-retire-npm-packages/ for the retirement details.


## Goal

Resolve stale PR #1 (`upstream-fixes`, b2f1870, open ~14 days). Cherry-pick fixes still valid on current main; drop the rest; close the PR. Branch diverged 126 files / -11640 lines vs main — a straight merge is not viable.

## Verified ground truth (run 2026-05-24)

```
git log --oneline main -10
074813b feat: mobile UX fixes + per-user system prompt injection
93105eb fix: faster scan (drop git status/log per-repo)...
abf3018 feat: support N concurrent sessions per supervisor
... (substantial drift since PR opened)
```

```
grep -n "subscribe(" web/src/components/Layout.tsx
60:  useEffect(() => {
61:    return subscribe((msg) => { ... })
```
=> Handler leak ALREADY FIXED on main. `subscribe()` is inside `useEffect` returning the unsubscriber.

```
grep -rn "hashToken" hub/src/
hub/src/ws/channel.ts:35      export async function hashToken(...)
hub/src/api/plugin.ts:4       import { hashToken } from '../ws/channel'
hub/src/api/api-keys.ts:3     import { hashToken } from '../ws/channel'
hub/src/api/sessions.ts:4     import { hashToken } from '../ws/channel'
hub/src/ws/agent.ts:4         import { hashToken } from './channel'
hub/src/auth/api-key-middleware.ts:3  import { hashToken } from '../ws/channel'
```
=> Layering violation STILL PRESENT. 5 files import from `ws/channel.ts`. Extraction to `hub/src/lib/crypto.ts` still valuable.

```
grep -n "TIER_LIMITS\|Infinity" hub/src/**
(no matches in hub/src)
```
=> `TIER_LIMITS` removed from hub entirely (billing/tier code gone). Infinity bug moot. Only remaining ref is `.planning/codebase/CONCERNS.md` (doc).

```
grep -n "updateProfile" hub/src/{api/profile.ts,db/dal.ts}
db/dal.ts:167  export async function updateProfile(userId, fields: { display_name?, system_prompt? })
api/profile.ts:25  const updated = await updateProfile(userId, fields);
```
=> Signature already takes a fields object. PR's response-shape fix may already be applied — verify in Wave 1.

PR branch diff vs main: 126 files, +3338/-11640. Branch deleted SupervisorPage, ThinkingBlock, ToolUseBlock, UnreadBadge, useActivity, useTheme, lib/auth.ts that main still uses. Cannot merge.

## Per-change disposition

| # | PR change | Disposition | Reason |
|---|-----------|-------------|--------|
| 1 | Layout.tsx handler leak — wrap subscribe in useEffect | **DROP** | Already fixed on main (Layout.tsx:60-61). |
| 2 | Extract `generateSecureToken` + `hashToken` to `hub/src/lib/crypto.ts` | **REWRITE** | Layering violation still present (5 importers of `ws/channel`). Re-do on current main; update 5 import sites. |
| 3 | New `web/src/lib/api.ts` with `HUB_URL`, `authHeaders()`, `hubFetch()` | **VERIFY_THEN_APPLY** | Check if main already has a fetch helper; check current hook file shapes (useApiKey/useChat/useSessions/useAuth/useProfile diverged on PR branch). |
| 4 | Profile PATCH returns full profile not `{ok:true}` | **VERIFY_THEN_APPLY** | `updateProfile` already returns object; confirm the route returns it to client. |
| 5 | TIER_LIMITS Infinity → -1 sentinel | **DROP** | TIER_LIMITS no longer in hub/src. |
| 6 | Parallelize DB queries in sessions.ts / plugin.ts via Promise.all | **VERIFY_THEN_APPLY** | Inspect current sessions.ts + plugin.ts for sequential awaits. |
| 7 | Move TIER_LIMITS profile.ts → config.ts | **DROP** | Code gone. |
| 8 | Wrap hook mutations in `useCallback` | **VERIFY_THEN_APPLY** | Hook files heavily changed on main; assess case-by-case, low priority. |
| 9 | Sidebar action `<span>` → `<button type="button">` | **VERIFY_THEN_APPLY** | Sidebar restructured on main; grep for offending `<span` with onClick. |
| 10 | App.tsx dedup: extract `LoadingScreen`, drop duplicate Layout | **VERIFY_THEN_APPLY** | App.tsx likely restructured; check for duplicate Layout render and inline loading markup. |

## Constraints

- One commit per change. No batch commits.
- No new abstractions beyond what PR proposed (crypto.ts, api.ts).
- Do not touch deleted-on-main features (SupervisorPage etc. are correct as-is).
- Close PR #1 with comment linking new commits; delete `upstream-fixes` branch (local + remote).

## Out of scope

- Re-introducing billing/tier code.
- Reviving deleted components.
- Any refactor not in original PR.
