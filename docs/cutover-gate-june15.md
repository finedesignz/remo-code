# June-15 Cutover Gate — Runbook + Measurement Procedure

**Status: authored; measurement PENDING a live post-June-15 account.**

This runbook encodes the SPEC's *"Verify after June 15"* checks as an explicit, operator-run
**measurement procedure** driven by the Phase-18 dual-bucket usage poll. It is the single source
of truth for **how the default human backend is decided** and **how the irreversible cutover
(default flip to PTY + ChatSurface deletion) is unblocked**.

> **NOT A BUILD BLOCKER.** Phases 15–18 ship before June 15. The gate gates exactly two
> operational actions: (R-PTY-22) the **default-on flip** of the human backend to Claude-PTY, and
> (Phase-17) the **ChatSurface deletion**. Everything else is buildable and shippable now.

---

## What the gate protects

1. **Billing classification of an interactive `claude` PTY turn.** If a genuine interactive
   `claude` TUI turn (raw bytes, no `-p`/stream-json) bills the **interactive** subscription bucket,
   Claude stays the default human backend. If it bills the **programmatic** bucket, the default human
   backend becomes **Codex** (fail-safe — see the decision rule). No API key, ever.
2. **The ChatSurface (stream-json) deletion.** Irreversible. Gated separately by
   `tools/cutover-deletion-gate.mjs`, which consumes the Phase-16 ship-verdict artifact
   (`16-VERIFICATION.md`) and refuses (exit 1) until the two on-device attestation triplets are
   recorded. See *"Unblocking the deletion gate"* below.

---

## The four SPEC checks (measurement procedure)

Each check is a **before/after dual-bucket snapshot diff**: snapshot the buckets, run ONE controlled
interactive PTY turn, snapshot again, record **which bucket's `used`/utilization moved**. The poll is
Phase 18's `supervisor/src/usage/oauth-poll.ts` → `hub/src/usage/store.ts` snapshot, rebroadcast on the
`subscription_usage` WS path. Read the `five_hour` / `seven_day` (interactive) windows vs the
programmatic pool fields by name in the snapshot.

| # | Check | Procedure | Records |
|---|-------|-----------|---------|
| 1 | **Interactive `claude` PTY turn → which bucket?** | Snapshot buckets → run ONE interactive PTY `claude` turn (real TUI, empty argv, no stream-json) → snapshot → diff. | `interactive` \| `programmatic` \| `unknown` |
| 2 | **`setup-token` vs `login` classification.** | Repeat check 1 once authed via `login` (interactive OAuth) and once via `setup-token`. Compare which bucket each moves. `setup-token` is SUSPECT (may carry programmatic class). | per-auth: `interactive` \| `programmatic` \| `unknown` |
| 3 | **Subagents / hooks / MCP inside an interactive session → bucket attribution.** | Snapshot → run an interactive turn that triggers a subagent + a hook + an MCP tool call → snapshot → diff. Confirms in-session automation does not silently bill programmatic under an interactive turn. | `interactive` \| `programmatic` \| `unknown` |
| 4 | **Login-credential headless reclassification (ONGOING WATCH).** | Periodically re-run check 1 — Anthropic may reclassify how `login` credentials bill over time. This is **not a one-time check**; it is a standing watch re-run on each provider-policy change. | `interactive` \| `programmatic` \| `unknown` + date |

### Snapshot helper

The diff is a manual reading of two `subscription_usage` snapshots (before/after). No automated
flip helper exists by design — the billing classification is too consequential to auto-assert
(see Deferred Ideas in `19-CONTEXT.md`). Record each result in `cutover-gate-checklist.md`.

---

## Decision rule (UNAMBIGUOUS)

> **interactive ⇒ `default_human_backend = 'claude'` (resolves to `claude-pty`).**
> **programmatic ⇒ `default_human_backend = 'codex'` (resolves to `codex-pty`).**
> **unknown / not-yet-measured ⇒ FAIL-SAFE: default resolves to `codex-pty`. Claude-PTY is NEVER
> the default until check 1 records `interactive`.**

- The flip is a **recorded config change** (set `claude_interactive_confirmed = true` + the
  configured default), gated on check 1 = `interactive`. It is **not** an automatic behavior.
- It is **reversible by config**: a later check 4 result of `programmatic` re-disables Claude-PTY
  (the selector unlists it; alert fires; only an explicit operator override re-enables).

---

## Unblocking the cutover (operator steps)

The cutover is a **single guarded operation**: it is allowed only when both the billing gate
(decision rule above) and the deletion gate (`cutover-deletion-gate.mjs`) are open.

### Step A — record the billing measurement
1. On a live post-June-15 account, run checks 1–4 (above), filling `cutover-gate-checklist.md`.
2. Apply the decision rule. If check 1 = `interactive`, set the recorded gate flag
   `claude_interactive_confirmed = true` and `default_human_backend = 'claude'`. Otherwise leave the
   fail-safe (`codex-pty`).

### Step B — record the Phase-16 on-device attestations (unblocks the deletion gate)
The deletion gate reads `16-VERIFICATION.md`'s frontmatter. It currently FAILS because:
`verdict: PARTIAL`, `render_fidelity: FAIL`, `mobile_reattach: FAIL`, and the two
`manual_attestation` triplets are empty. To open it, the operator must verify ON A REAL DEVICE and
edit the frontmatter so that ALL of the following hold (per `tools/phase16-verdict-schema.mjs`):

```yaml
verdict: PASS
render_fidelity: PASS
mobile_reattach: PASS
automated_suite:
  result: PASS
  summary: "pass=… skip=… fail=0 total=…"   # must already be green
term_relay_auth:
  result: PASS
manual_attestation:
  render_fidelity: { by: "<name>", at: "<ISO-8601>", device_build: "<device + app build>" }
  mobile_reattach: { by: "<name>", at: "<ISO-8601>", device_build: "<device + app build>" }
```

- `render_fidelity` attestation = a human confirmed the PTY terminal renders faithfully on the
  target device (R-PTY-07).
- `mobile_reattach` attestation = a human confirmed a mobile session reattaches with scrollback
  intact after disconnect (R-PTY-09).
- Each triplet MUST carry a non-empty `by` + `at` + `device_build`. A bare `PASS` with an empty
  triplet is rejected as a forgery (the gate fails the provenance check).

### Step C — verify the gate is open
```bash
node tools/cutover-deletion-gate.mjs
# exit 0 → "Deletions allowed"  → cutover may proceed
# exit 1 → still blocked → DO NOT cut over; the printed reasons name the missing fields
```

### Step D — execute the cutover (only after A + C)
Flip `default_human_backend` per Step A, then run the Phase-17 ChatSurface deletion guarded by the
gate (the deletion script self-aborts unless `cutover-deletion-gate.mjs` exits 0). This step is
**deferred** in Phase 19 (`deferred:blocked-on-manual-gate`) — Phase 19 builds everything except this
irreversible flip + deletion.

---

## Hard invariants carried into the gate

- **No `ANTHROPIC_API_KEY` / no API-key fallback, ever.** The fallback is a backend-CLI swap on the
  same PTY surface (Codex primary, Gemini-stub future), never the API platform.
- **Official client only**; the OAuth token is never serialized to the hub.
- **Only genuine human turns touch the PTY.** Automation stays on the programmatic/stream-json path
  behind the non-bypassable cost cap (or moves to Codex).
- **Interactive CLI only for human sessions** — no `-p`, no `--input-format`/`--output-format`,
  no `stream-json` on the PTY path.
- **`setup-token` is suspect** — used only when a host can't be touched locally, and only after its
  billing classification is verified (check 2).

See `.planning/architecture/interactive-pty-runner-SPEC.md` §"Verify after June 15",
§"If PTY fails", §"Hard constraints" for the authoritative source.
