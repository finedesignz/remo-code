# CORCH-09 summary

Status: implemented, tested, PR open (stacked on CORCH-08). R4.1-R4.5 complete. **R3.8 is BLOCKED-ON-MCP** (no hub->memlog transport): the claim client is an injected seam whose default refuses `memlog_unavailable`; all claim lifecycle logic is built and proven against a fake memlog.

## Delivered
- Supervisor: `account_slot` in `supervisor.hello` only with `REMO_ACCOUNT_SLOT` (R4.1); slot spawn env in the stream-json runner (OAuth token + `CLAUDE_CONFIG_DIR` required, API key scrubbed, deploy creds scrubbed, git push env kept, output redacted) (R4.2); `corch.worktree_ensure|worktree_remove|pr_lookup` (R4.4, R4.5), sandboxed, deterministic `<root>/corch/<name>-<id>` on `corch/<id>` off the remote default branch, clone origin bound, host-scoped credential helper, single deadline, never advertised.
- Hub: real `Workspace` and `PrLookup` (`hub/src/corch/workspace.ts`) wired behind the CORCH-01 seams (only built when the flag is ON; defaults unchanged); `MemlogClient` seam (`memlog.ts`); claim fencing per item; release on requeue/blocked/done/cancelled; reconciler heartbeats live-run and pr_open claims; gsd-console cancellations and AAF closures clean up; `haltBeforeMachineSend` before every `corch.*` frame; `corch.*` in the RPC allowlist only.
- Guards: `hub/test/corch-no-token-guard.test.ts` (no token or API key in hub, halt precedes every frame), supervisor frame test.
- Docs: `docs/corch.md` "Slot injection, worktrees and PR lookup", CLAUDE.md env section. No schema change; no route change (docs:sync clean).

## Success criteria
1. `supervisor/test/corch-slot.test.ts`: account_slot only with the slot; spawn env; API key scrubbed; `no-setup-token-on-interactive`, `no-api-key-no-streamjson-pty`, `no-apikey-fallback-guard` green.
2. `corch-no-token-guard` green; frame test (no env value leaves the supervisor).
3. `supervisor/test/corch-worktree.test.ts` (temp git repos): deterministic path/branch, reuse, traversal refusal, remove on done/cancelled not blocked (hub `corch-workspace` + e2e), halt precedes every frame (guard).
4. `corch.pr_lookup` with fake gh: open same-repo => url; none/fork => none; reply carries no credential.
5. `hub/test/corch-workspace.test.ts` + e2e with fake memlog: claim before worktree_ensure, heartbeat, release on terminal states, conflict => `memlog_conflict`, unreachable => `memlog_unavailable` + one ticket, no dispatch without a claim.
6. `hub/test/e2e/corch-slot.e2e.test.ts` (real Postgres, fake slot supervisor, real Workspace/PrLookup): claim -> worktree -> launch -> turn end -> lookup -> pr_open -> done release.

## Tests
supervisor: corch-slot 11, corch-worktree 15 (full supervisor suite: 3 pre-existing PTY failures also failing on the CORCH-08 base: pty-byte-relay etc.). hub: corch-workspace 21, corch-no-token-guard 7, corch-slot e2e 10, corch-aaf-events +1. `check-baseline`: pass=4213 fail=0.

## QC
Codex (external) rounds 1-3: QC-FAIL each (9, 7, 4 findings; see QC-R1..R3.md, QC-ADJUDICATION.md). All fixed; round-3 fixes verified by tests but not re-reviewed externally (3-round cap). Adjudicated by design: no-slot spawn still inherits an operator-set token (existing behavior, R4.2 "human path unchanged"); split/re-encoded secret redaction limit.

## Tickets / requests
7e: memlog_note request to `mcp-servers` (`mem:mcp-servers:requests` id 1794637033307-0): hub->memlog transport. `autofix-report mcp-servers` returned HTTP 401 invalid_key (not retried).

## Flags / env (all default OFF / unset)
Supervisor: `REMO_ACCOUNT_SLOT`, `REMO_SLOT_CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`. No new hub env. `REMO_CORCH_ENABLED` still OFF; with it ON nothing launches until a real MemlogClient exists (BLOCKED-ON-MCP) and a slot supervisor is online.

## Cutover items added
A new signed supervisor MSI/image build for the slot supervisor (CORCH-10 image runs this code); a real `MemlogClient` (after the mcp-servers endpoint exists); git credential env on the slot (`GH_TOKEN`).
