<!-- updated: 2026-07-16 -->
# Milestone EMS — ext/mcp "Second-Witness" Connector Ship — REQUIREMENTS

**Milestone CODE:** `EMS` (phase dirs/labels prefixed `EMS-NN-slug`, collision-safe per global rule).
**Status:** SCOPED ONLY — this milestone is planned, not yet executed. Worktree:
`C:\Users\artic\GitHub\remo-code-ext-mcp-ship`, branch `feat/ext-mcp-ship` (off `main`).
**Owner ask (paraphrased):** ship the already-built ext/mcp connector so `remo_*` tools load in the
TLP verify-close sweep as a second witness on remo-owned work.

## Goal

The ext/mcp "second-witness" connector — `@remo-code/mcp` (an MCP server: `remo_list_sessions`,
`remo_read_memory`, `remo_read_transcript`, `remo_ask`, `remo_get_ask`) plus the hub's `/api/ext`
surface and scoped API-key auth — is **fully implemented** on unmerged feature branches but lives
nowhere reachable: not on `main`, not on the live hub (`app.remo-code.com`), not published, not
registered in any Claude config. This milestone is **finish → ship → wire**, not rebuild: consolidate
the existing commits, prove them, ship them, and wire the TLP scheduled verify-close sweep to
actually use them.

## Source state (do not re-derive — already audited)

All ext/mcp work sits on commit `1b4efb2` and descendants, duplicated with drift across 6 local/
remote branches (`fix/dockerfile-mcp-workspace`, `fix/update-reap-sidecar`, `fix/mobile-tap-focus`,
`fix/terminal-focus-latch`, `fix/extwork-scope-explicit`, `feat/roots-ui`). Canonical/most-complete:
**`fix/dockerfile-mcp-workspace`** (18 commits ahead of `main`, 0 behind). None of the 6 are merged.

**The 8-commit ext/mcp core** (chronological, all present on the canonical branch — see EMS-01):

| Commit | Subject |
|---|---|
| `617e8e5` | fix(self-heal): fence untrusted payloads, scope-contract + propose-only for machine dispatch |
| `1f596a7` | feat(ask): external session-ask + read surface for Claude Desktop scheduled tasks (#366) |
| `e4938b9` | feat(auth): named, scoped, multi API keys + Credentials UI (#367) |
| `d546607` | fix(work): pin the verified SHA end-to-end + remove the agent's push credential (#368) |
| `d794663` | chore(supervisor): bump to v0.14.0 — session read commands + hub-commanded work push (#369) |
| `1b4efb2` | feat(scheduler): one-time tasks; `/api/ext` work+ask are gated one-time tasks (#371) |
| `357ba2f` | fix(ext): ext:work requires explicit scope — legacy/NULL keys can no longer publish (#373) |
| `fca3393` | fix(docker): COPY mcp/package.json so the bun workspace install resolves |

**Excluded as unrelated** (present on the same branches, interleaved, NOT ext/mcp): `ddc4af3`
(autostart reconcile), `60ef716` (revanote payload shape), `1a7e4d5` (Rust auto-update),
`81e0acd`/`624b6f1`/`fe5d0b2`/`9b90792` (PTY scrollback, mobile terminal focus), `c88dbb5`
(Connections root-folders UI), `3dba790` (sidecar reap v0.14.1), `f821ef5` (PTYCAP planning dirs).
These stay on their source branches; EMS cherry-picks only the 8-commit core.

## Constraints (encoded in phase success criteria)

- **Do not touch the 6 source branches.** A sibling session may be live on
  `fix/update-reap-sidecar` (see `active-sessions.md`). Read them with `git log`/`show`/`diff` only;
  consolidate by cherry-pick INTO `feat/ext-mcp-ship`.
- **Hub deploy and npm publish are outward-facing and irreversible.** Both are gated phases
  requiring explicit owner go-ahead before execution, per `DEPLOY-SAFETY.md` convention.
- **schema.sql re-runs every hub boot** — any DDL introduced by the cherry-picked commits must
  already be idempotent (it was written pre-EMS; EMS does not add new schema).
- **Mount-order invariant**: `/api/ext` mounts before the cookie/JWT catch-all
  (`hub/test/mount-order.test.ts` enforces) — preserved as-is by the cherry-pick, verified in EMS-02.
- The TLP scheduled verify-close sweep lives OUTSIDE this repo, at
  `C:\Users\artic\Claude\Scheduled\`. EMS-08/EMS-09 touch that location, not `remo-code`.

## Requirements (REQ-IDs)

### CONS — consolidate the scattered commits

- **CONS-01 (clean cherry-pick set):** the 8-commit ext/mcp core (table above) is cherry-picked or
  rebased onto `feat/ext-mcp-ship` (off `main`), in original chronological order, with zero
  unrelated commits (mobile/terminal/supervisor-autostart/revanote/Connections-UI) carried along.
- **CONS-02 (buildable):** the resulting branch builds clean — `hub/` typechecks and its existing
  test suite runs; no cherry-pick left a half-applied hunk or merge-conflict marker.
- **CONS-03 (mcp workspace resolves):** `mcp/package.json` is present and the root bun workspace
  install resolves `mcp/` as a workspace member (the `fca3393` fix is included and verified, not
  just cherry-picked).

### QC — prove the consolidated branch works

- **QC-01 (hub builds + existing tests green):** `hub/` builds and its full existing test suite
  (including `hub/test/mount-order.test.ts`) passes on the consolidated branch — no regression from
  the cherry-pick.
- **QC-02 (mcp package builds + binary starts):** `mcp/` builds; running the `remo-code-mcp` bin
  (`bun run mcp/src/index.ts` or equivalent) starts an MCP server process and, over the MCP
  protocol, lists exactly the 5 tools: `remo_list_sessions`, `remo_read_memory`,
  `remo_read_transcript`, `remo_ask`, `remo_get_ask`.
- **QC-03 (ext-api-key-middleware scope enforcement):** a request to `/api/ext/*` with no
  `api_key` → 401; with a key scoped `ext:read` only, hitting an `ext:ask`-scoped route → 403; with
  a key carrying both scopes → 2xx. Proven by test, not inspection.
- **QC-04 (legacy/NULL-scope keys stay locked out of work):** `357ba2f`'s guarantee — a legacy or
  NULL-scope key cannot dispatch `ext:work` — is covered by an explicit passing test on the
  consolidated branch (not just present in the diff).

### SHIP — merge and deploy the hub side (GATED)

- **SHIP-01 (merge to main):** the consolidated, QC-passed branch is merged to `main` via
  `gh pr merge --squash --delete-branch --admin` after CI is green — only after explicit owner
  go-ahead (outward-facing/irreversible per rule 12).
- **SHIP-02 (Coolify deploy + live verify):** the hub is redeployed to Coolify
  (`app.remo-code.com`) and `/api/ext` is verified LIVE: unauthenticated request → 401, a request
  bearing a valid scoped key → 2xx. `/health` alone does not satisfy this — the actual route is hit.
- **SHIP-03 (docs/openapi updated):** `/openapi.json` reflects the `/api/ext` routes; `docs/api.md`
  is regenerated/committed per the docs standard (global rule 32) — no `TODO: document` left behind.

### PUB — make the mcp client resolvable (GATED)

- **PUB-01 (invocation decided and documented):** exactly one of (a) `@remo-code/mcp` published to
  npm so `bunx remo-code-mcp` / `npx -y @remo-code/mcp` resolves publicly, or (b) a pinned
  local/tarball invocation (absolute path or git-pinned tarball URL) is chosen and documented as
  the canonical invocation string. This is an explicit owner decision, not an implementer default.
- **PUB-02 (invocation actually works):** the chosen invocation, run from a clean shell with no
  local repo checkout assumptions (or with the documented prerequisite stated), successfully starts
  the MCP server and lists its 5 tools — proven by a real run, not by reading `package.json`.

### PROV — provision credentials and register the connector

- **PROV-01 (scoped API key provisioned):** an API key carrying both `ext:read` and `ext:ask`
  scopes is created in remo-code Settings → Credentials against the live (post-SHIP) hub, named
  distinctly (e.g. `tlp-verify-close-sweep`), and its secret is captured for PROV-02 — never
  committed to any repo.
- **PROV-02 (connector registered in the TLP sweep config):** the ext/mcp connector is registered
  in the TLP scheduled verify-close sweep's Claude config at `C:\Users\artic\Claude\Scheduled\`
  (its verify-close skill's Appendix B connector block), using the chosen PUB-01 invocation plus
  `REMO_HUB_URL=https://app.remo-code.com` and `REMO_API_KEY=<PROV-01 secret>`. This file is
  OUTSIDE the `remo-code` repo — EMS documents the exact block added, it does not commit it here.

### E2E — prove the second-witness loop end-to-end

- **E2E-01 (tools load in a real sweep run):** a real (non-dry-run) TLP verify-close sweep
  execution shows all 5 `remo_*` tools loaded and callable — not merely configured.
- **E2E-02 (second-witness verdict reconciles):** for a task whose implementation work was done by
  a remo-code-owned session, the sweep's second-witness check calls `remo_read_transcript` and/or
  `remo_ask` against that session and produces a reconciled verdict (agreement or a surfaced
  discrepancy) — proving the loop is load-bearing, not merely wired.

## Out of Scope (with reasoning)

- **Rebuilding or redesigning any ext/mcp feature.** Everything in the 8-commit core is already
  implemented and reviewed (each carries a merged-quality PR number); EMS's job is finish/ship/wire,
  not feature work. Any bug found in QC gets the smallest fix, not a redesign.
- **The 10 excluded commits** (mobile/terminal focus, supervisor autostart, revanote payload shape,
  PTY scrollback, Connections root-folders UI, sidecar reap v0.14.1, PTYCAP planning dirs). These
  are real, wanted changes but belong to their own branches/milestones — EMS does not ship them as
  a side effect of consolidation, and does not delete them from their source branches either.
- **New MCP tools beyond the existing 5.** Any expansion (e.g. `remo_list_repos`) is a future
  requirement, not this milestone.
- **Changing PTYCAP/MSESS/OBSRV scope, sequencing, or the milestone queue** in `PROJECT.md`/
  `ROADMAP.md`. EMS is additive; it does not reorder the existing milestone queue.

## Future Requirements (explicitly deferred)

- Multiple TLP-style external consumers registering distinct scoped keys (self-serve key
  management UI beyond the existing Credentials page).
- Rate-limiting / per-key spend ceiling on `/api/ext` (today's token-cap gates cover dispatch;
  a per-external-consumer ceiling is a natural follow-on, not required to ship this connector).
- Automated CI check that fails the build if `mcp/`'s 5-tool contract drifts from `hub/src/api/ext.ts`.
