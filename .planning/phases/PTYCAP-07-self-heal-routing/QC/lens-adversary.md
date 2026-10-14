# PTYCAP-07 QC - Adversary lens (security / blast radius)

Scope: `git diff ec2237e..HEAD -- hub/ supervisor/`. Method: code read plus running token-cap-coverage, counter-key-assignment-guard, launch-callers-guard, heal-route-guards, governed-launch, heal-single-seam (all pass; none cover finding 1).

VERDICT: CONTENT-BLOCK (1 MAJOR)

## Findings

### 1. MAJOR - heal autospawn starts untrusted-triggered sessions with the session's `dangerously_skip_permissions`
- Where: hub/src/telegram/launch.ts:202,227 (`skipPerms = getSessionSkipPermissions(...)`, sent unconditionally in `session.start`); reached from hub/src/dispatch/governed-launch.ts:169 (`launchSessionForUser({machine:true})`) via hub/src/heal/route.ts:286 (`autospawnHeal`).
- Baseline: error-capture and feedback used `ensureSessionOnline` -> spawn-on-error.ts:225-232, which forces `skipPerms=false` unless `useSessionSkipPermissions` (Revanote only). Repo invariant (CLAUDE.md, "Machine-triggered spawns force dangerously_skip_permissions: false") and ROADMAP hard invariant. The flag-ON heal path silently reverses it for the exact untrusted sources (public DSN error intake, public feedback token, deploy-log text, task error text).
- Exploit: owner session has `dangerously_skip_permissions=true` and is offline. Attacker submits feedback or an error report (public token or DSN) with a prompt-injection payload. `routeHeal` -> `offline_candidate` -> `governedLaunch` -> `session.start` with skip-permissions true. The supervisor ceiling `allow_dangerous_skip_permissions` is the only remaining limit. The injected agent then runs with no permission prompts. The fence and scope contract are prompt-level only, not a code control.
- No test in hub/test/heal-* or governed-launch.test.ts asserts the flag value (only launch-run-leak.test.ts mentions it).
- Fix: add an explicit option to `launchSessionForUser` (for example `skipPermissions: false`, or force false whenever the caller is the heal governor), thread it through `GovernedLaunchDeps.launchSessionForUser`, and let only the orchestrator legacy path keep session-derived behavior. Add a test asserting the heal `session.start` frame carries `dangerously_skip_permissions:false` even when the session row is true.

### 2. MINOR - PTY denial exists only at resolve time and is absent from the gate chain
- hub/src/heal/route.ts:112-119 omits `governedAutomationPtyGate` (the ask/work paths include it; ask/dispatch.ts:141). The only PTY check is `runner_type === 'pty-interactive'` in heal/resolve.ts:253,271, evaluated before the claim, the autospawn wait (up to `REMO_HEAL_SPAWN_TIMEOUT_MS`, 25s) and any parked replay. A user flipping the session to PTY in that window gets a heal turn injected into the human's PTY. Narrow window, but the invariant says the denial must hold at dispatch. Fix: add a PTY gate (actor `self-heal`) to the single gate list.

### 3. MINOR - per-user claim cap is a shared starvation lever
- heal-events-dal.ts claim: the 30/hour cap counts all sources per user. An attacker with the public DSN or feedback token can mint distinct dedupe keys (`err:<project>:<fingerprint>`, `fb:<submissionId>`) and exhaust the cap, so legitimate Coolify and scheduled-task heals are refused (`user_claim_cap`, no owner notification). It does NOT raise spend (bounds still hold: 4 per repo per hour, token and cost caps, lifetime counter). Fix: per-source sub-cap, or reserve headroom for coolify and scheduled sources.

### 4. MINOR - Coolify flag-ON path fetches logs before any dedupe
- hub/src/api/coolify-webhook.ts `dispatchTriageViaHeal` calls `fetchTriageLogSnippet` (outbound Coolify API call) on every authenticated webhook before `routeHeal` claims, where the legacy path claimed the storm key first. This amplifies outbound calls under a crash-loop storm, and a fetch throw there leaves the run record without the route's terminalization. Fix: claim or dedupe before the fetch, or catch and terminalize.

### 5. MINOR - launch-cap check is not atomic with the ledger insert
- governed-launch.ts:116-120 (read count) versus :159 (append row): concurrent heals can exceed `launch_cap` by the concurrency level. Bounded in practice by the 4 per repo per hour and 30 per user per hour caps. Fix: count and insert under the reservation lock.

## Verified clean (no finding)
- Cross-tenant: bound sessions go through `getSession(id, userId)` (owner-scoped); the feedback/error `bound_session_id` is revalidated; repo mismatch yields `none`; no silent repo fallback.
- Ordering: gates, atomic reservation and ledger row run before `launchSessionForUser`; the reservation is released on every refusal and failure; launch run is closed on non-launch exits.
- Gate chain: a single gates literal contains kill switch, threshold, cost, token, session inject rate and lifetime; token-cap-coverage passes.
- Counter key: server-derived canonical repo_ident only, null refused, never raw event text; assignment-guard passes.
- Untrusted text: prompts are fenced, the scope contract is appended idempotently (the attacker copy cannot match because `<` is escaped); owner email is cleaned, ASCII, HTML-escaped and sent to the owner only.
- Recursion: provenance guard runs before the claim, fails closed; internal tasks and reaper finalizers excluded.
- Webhook: raw-body/HMAC/mount-order untouched (diff limited to the flag switch).
