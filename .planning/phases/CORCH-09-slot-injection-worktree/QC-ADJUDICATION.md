# QC adjudication

## R1 finding 4 (MED): "no-slot spawn still inherits CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR" - by design, not changed

Requirement text (R4.2): the stream-json runner passes the process's `CLAUDE_CODE_OAUTH_TOKEN` and per-slot `CLAUDE_CONFIG_DIR`
"through `sanitizeSpawnEnv` only when `REMO_ACCOUNT_SLOT` is set", and "the human PTY path is unchanged".

Verified fact (RESEARCH.md item 2): `sanitizeSpawnEnv` has never scrubbed `CLAUDE_CODE_OAUTH_TOKEN` (not in `PROVIDER_KEY_DENYLIST`, matches no
`CREDENTIAL_PATTERNS`), so the token already reaches every spawn that inherits `process.env`. That is how a supervisor launched
by the CUG token switcher (owner's `CLAUDE_CODE_OAUTH_TOKEN` in the launcher env) authenticates its stream-json automation and its
human PTY. Scrubbing it from the no-slot stream-json spawn would silently break that existing authentication for the owner's own
desktop supervisor, and scrubbing it from the shared denylist would change the human PTY path, which R4.2 says must be unchanged.

What R4.2 actually adds, and what is enforced: with the slot set the spawn is FAIL-CLOSED (token and config dir required, injected
explicitly, API key scrubbed, git push env kept, output redacted); without the slot nothing new is injected (no `CLAUDE_CONFIG_DIR`,
no `account_slot`), so a desktop MSI is never a CORCH target and CORCH never routes to it. A desktop operator who sets the token
in their own environment is using their own account, outside CORCH. Tests: `supervisor/test/corch-slot.test.ts` ("no slot").
Risk accepted: none new; behavior without the slot is byte-for-byte the previous behavior.
