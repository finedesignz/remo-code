# CORCH-09 research

## (1) hub -> memlog transport (A7): NONE verified
- memlog is `mcp-servers/apps/memlog` (`src/http-server.ts:1-20`): `createHttpServer((gatewayToken) => createServer(gatewayToken))`,
  manifest `auth_type: "none"`, tools `memlog_claim/heartbeat/release/claims/orphans/takeover` (`src/tools/claims.ts:27,60,81,108,132,155`),
  gateway-only (docs/api.md "Credential" section). The only way in is the MCP Factory gateway with a gateway token.
- remo-code hub has no memlog or MCP Factory client: grep of `hub/src` and `supervisor/src` for `memlog|mcp_factory|cgw_` finds only
  `hub/src/corch/routes.ts:79` / `store.ts:15` (a `source` enum value `memlog`), `agentautofix/reporter.ts` and error-capture snippet text.
  No gateway credential exists in hub config.
- Decision: no workaround transport. `hub/src/corch/memlog.ts` defines the `MemlogClient` seam; default refuses `memlog_unavailable`
  (item waits, bounded re-evaluation after one lease, one ticket per process). R3.8 = BLOCKED-ON-MCP; 7e request filed via memlog_note
  (`mem:mcp-servers:requests` id 1794637033307-0). `autofix-report mcp-servers` returned HTTP 401 invalid_key (no key provisioned for that slug in this
  session); the memlog_note carries the request.

## (2) sanitizeSpawnEnv and CLAUDE_CODE_OAUTH_TOKEN
- `supervisor/src/runners/env-sanitize.ts:23-48,116-119`: the token is NOT scrubbed today. `CLAUDE_CODE_OAUTH_TOKEN` is not in
  `PROVIDER_KEY_DENYLIST` and matches none of `CREDENTIAL_PATTERNS` (`/_AUTH_TOKEN$/` needs `_AUTH_`; the name has `_OAUTH_`). It already survives
  every spawn that inherits `process.env` (this is also why a CUG-launched human PTY works).
- Therefore "let it through only for the slot" is done additively: `supervisor/src/slot.ts` `slotSpawnEnv` injects token + `CLAUDE_CONFIG_DIR` after
  `sanitizeSpawnEnv`, only when `REMO_ACCOUNT_SLOT` is set (both required, fail closed); `claude-runner.ts` also keeps the git-push env for a slot.
  The denylist is deliberately NOT changed (would break the owner's CUG human sessions and change PTY behavior). `ANTHROPIC_API_KEY` stays scrubbed
  (`claude-runner.ts` delete + `PROVIDER_KEY_DENYLIST`); `no-setup-token-on-interactive`, `no-api-key-no-streamjson-pty`, `no-apikey-fallback-guard` green.

## (3) supervisor command allowlist
- Native commands: `supervisor/src/commands/index.ts` `HANDLERS` map (`getHandler`, hub-client `onRunCommand` `hub-client.ts:~844`) plus the advertised `NATIVE` list.
  Added `corch.worktree_ensure|worktree_remove|pr_lookup` to both.
- Hub side allowlist: `hub/src/ext/supervisor-read.ts` `EXT_READ_COMMANDS` (the only correlated hub->supervisor RPC seam).
  `hub/src/corch/workspace.ts` is the sole sender; it calls `haltBeforeMachineSend` (`dispatch/automation-controls.ts:171`) before every frame;
  pinned by `hub/test/corch-no-token-guard.test.ts`. `kill-switch-coverage` only scans `gates: [...]` lists (no new list added): green.

## Other findings
- Hello: the hub already accepts and stores `account_slot` (`ws/supervisor-protocol.ts:19`, `ws/agent.ts:914`, `supervisor-registry.ts:216-306`) and CORCH-02 selection keys on it; only the supervisor side was missing.
- Ordering: the quota account is recorded inside the gate chain, AFTER `Workspace.resolve`. The real Workspace therefore calls `quota.snapshotFor` itself (idempotent for a run that holds its account) to know which supervisor to command.
- A8/A10: PR existence is read by the worker's own supervisor with `gh` (no hub GitHub credential).
