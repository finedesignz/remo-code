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

## R2 finding 1 (HIGH, token redaction incomplete): partially fixed, remainder adjudicated as an accepted limit

Fixed: redaction now covers the slot token AND the git credentials the slot keeps in env (`GH_TOKEN`, `GITHUB_TOKEN`), in string
values and object keys. Not fixed, by design: a secret split across SEPARATE events (e.g. two `text_delta` chunks) or re-encoded by the
child (base64, hex) is not caught. Closing that would require holding back every streamed delta (a latency/semantics change to all
streaming) and still could not stop re-encoding. The redaction is a backstop, not the boundary: the boundaries are (a) the hub holds no
token and has no code path that reads one (guard test), (b) the token exists only in the supervisor and its own `claude` child, (c) that child is
the slot's own authenticated worker, so any agent able to print its env already holds the credential the slot was given. A
prompt-injected worker exfiltrating its own subscription token via a self-chosen encoding is the same residual risk as any agent holding a
credential; the rotation-free mitigation is least privilege (deploy credentials scrubbed, API key scrubbed, one token per slot).
