# CORCH Linux slots (headless per-slot supervisor image)

Milestone CORCH phase 10 (R4.6, R4.7). `Dockerfile.slot` builds ONE headless supervisor image; each Claude account
runs as its own container (a "slot") that registers with the hub and advertises `account_slot` in `supervisor.hello`
(CORCH-09). This phase builds the image only. Nothing is deployed and no real token exists in the repo.

The image runs the supervisor Bun source (same path as `tools/cloud-session/`): no Tauri, no ConPTY sidecar
(`pty-host.mjs` runs under the bundled Node), non-root (`node`, uid 1000), `claude` CLI installed globally.

## One app per slot

Create one Coolify application per account slot, all from `Dockerfile.slot` (build context = repo root). Never run two
accounts in one container: the slot token, config dir and volumes are per account. `REMO_MAX_CONCURRENT` defaults to 1.

## Runtime secrets

All are runtime env (Coolify "runtime only", never build args). The image has no ARG and no secret ENV; the entrypoint
refuses to start (exit 64) if any required one is missing and never prints a value.

| Variable | Required | Meaning |
|---|---|---|
| `REMO_ACCOUNT_SLOT` | yes | Slot id, `^[A-Za-z0-9_-]{1,64}$`; advertised as `account_slot` |
| `REMO_HUB_URL` | yes | Hub origin, for example `https://app.remo-code.com` |
| `REMO_API_KEY` | yes | This slot's own `purpose='host'` key (`POST /api/api-keys {host:true}`), written to a 0600 `supervisor.json` at start |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | Exactly one account's subscription OAuth token; handed only to the spawned `claude` child. No API key is supported |
| `REMO_GIT_TOKEN` | optional | Git credential for HTTPS clones/pushes, wired through an in-memory credential helper (nothing written to disk) |

Non-secret defaults baked in: `REMO_ROOTS=/data/work`, `REMO_SLOT_CLAUDE_CONFIG_DIR=/data/claude`,
`REMO_CODE_CONFIG_DIR=/home/node/.config/remo-code`, `REMO_MAX_CONCURRENT=1`.

On first start the entrypoint writes `/data/claude/settings.json` with a permission allowlist (A8) if none exists; an
operator-edited file is never overwritten.

## Volumes

- `/data/claude`: this slot's Claude config dir (`CLAUDE_CONFIG_DIR` of the child). Persist per slot.
- `/data/work`: repo checkouts and CORCH worktrees. Persist per slot.

## Update path

Rebuild the image from the target commit and redeploy the slot app (one at a time; a running session is lost on
restart and the hub reclaims it by lease). Volumes keep the config and checkouts. Rotating a slot token is an owner
action: change the Coolify runtime secret and redeploy.

## Registration check

1. Container log shows the supervisor connecting; no `[remo-slot] ... is required` line.
2. `GET /api/supervisors` lists the host and its `account_slot` equals `REMO_ACCOUNT_SLOT`.
3. `docker exec <c> id -u` is not 0; `docker history --no-trunc <image>` and `docker inspect <image>` contain no token.

Local smoke (dummy values only): `docker build -f Dockerfile.slot -t remo-slot .` then run with
`-e REMO_ACCOUNT_SLOT=slot-a -e REMO_HUB_URL=<local hub> -e REMO_API_KEY=<local host key> -e CLAUDE_CODE_OAUTH_TOKEN=dummy`.

## CI

`.woodpecker/slot-image.yaml` builds the image on pull requests that touch it (linux/amd64, `dry_run: true`: no
registry push, no deploy). `supervisor/test/corch-slot-image.test.ts` statically pins non-root, no secret ARG/ENV, and
no Tauri/ConPTY. Deploying slots with real tokens is CORCH cutover item 8.
