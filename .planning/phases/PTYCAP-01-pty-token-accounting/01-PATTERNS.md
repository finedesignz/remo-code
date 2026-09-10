# Phase 1: PTY Token Accounting - Pattern Map

**Mapped:** 2026-07-27
**Files analyzed:** 9 (new/modified)
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `supervisor/src/usage/pty-transcript-tail.ts` (NEW) | utility (file tailer) | streaming / file-I/O | `hub/src/telegram/transcript/tail.ts` | exact (port verbatim) |
| `supervisor/src/usage/pty-usage-emitter.ts` (NEW) | service (lifecycle owner + emitter) | event-driven | `hub/src/telegram/transcript/claude-adapter.ts` (`mapClaudeRecord`) for parse shape; `supervisor/src/runners/session-bridge.ts` (`result` handler, lines 471-490) for emission shape | role-match |
| `supervisor/src/runners/claude-pty-bridge.ts` (MODIFY: wire tail lifecycle at spawn/kill) | runner / bridge | streaming | itself (existing `start()`/`kill()`, lines 94-139) | exact (extend in place) |
| `supervisor/src/runners/types.ts` (MODIFY: extend `usage_event` type) | type/config | request-response | itself (existing `usage_event` variant) | exact |
| `hub/src/ws/agent.ts` (MODIFY: thread `runner_type` through) | controller (WS handler) | request-response | itself (existing `usage_event` handler, lines 756-794) | exact |
| `hub/src/db/token-usage-dal.ts` (MODIFY: add `runnerType` param) | service / DAL | CRUD | itself (`recordTokenUsage`, lines 30-68) | exact |
| `hub/src/db/schema.sql` (MODIFY: additive `runner_type` column + check + index) | migration | batch/DDL | itself (`sessions.runner_type` block, lines 635-642) | exact |
| `supervisor/test/pty-usage-tail.test.ts` (NEW) | test | integration | `hub/test/transcript-adapter-claude.test.ts` (fixture + adapter test pattern) | role-match |
| `hub/test/token-usage-runner-type.test.ts` (NEW) | test | unit | `hub/test/transcript-adapter-claude.test.ts` (assertion style); `hub/src/db/token-usage-dal.ts` (subject) | role-match |
| `hub/test/pty-usage-midflight-visibility.test.ts` (NEW) | test | integration | `hub/test/transcript-adapter-claude.test.ts` | role-match |
| `hub/test/usage-event-handler.test.ts` (EXTEND, exists) | test | unit | itself | exact |
| `hub/test/no-hub-side-transcript-fs.test.ts` (NEW, optional guard) | test (static/guard) | batch | `supervisor/test/no-legacy-agent-spawn.test.ts` (grep-based canary style, cited directly in RESEARCH.md) | role-match |

## Pattern Assignments

### `supervisor/src/usage/pty-transcript-tail.ts` (NEW)

**Analog:** `hub/src/telegram/transcript/tail.ts` — port verbatim per RESEARCH.md's explicit "Don't Hand-Roll" directive. Do not alter the byte-offset/carry/truncation/watch+poll-fallback logic.

**Full pattern to copy** (`hub/src/telegram/transcript/tail.ts:1-128`):
```typescript
import { watch, type FSWatcher } from 'node:fs'
import { open as fsOpen, stat } from 'node:fs/promises'

const POLL_INTERVAL_MS = 500

export interface JsonlTail {
  close(): void
}

export function tailJsonl(
  path: string,
  onRecord: (record: unknown) => void,
  opts?: { onParseError?: (line: string, err: unknown) => void; fromStart?: boolean },
): JsonlTail {
  let offset = 0
  let carry = ''
  let closed = false
  let reading = false
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const onParseError = opts?.onParseError

  async function pump(): Promise<void> {
    if (closed || reading) return
    reading = true
    try {
      let size: number
      try {
        size = (await stat(path)).size
      } catch {
        return // file not present (yet) — poll/watch will retry
      }
      if (size < offset) {
        // Truncated/rotated — reset and re-read from the top.
        offset = 0
        carry = ''
      }
      if (size === offset) return
      const fh = await fsOpen(path, 'r')
      try {
        const len = size - offset
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset)
        offset = size
        const chunk = carry + buf.toString('utf8')
        const lines = chunk.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            onRecord(JSON.parse(trimmed))
          } catch (err) {
            onParseError?.(trimmed, err)
          }
        }
      } finally {
        await fh.close()
      }
    } finally {
      reading = false
    }
  }

  if (opts?.fromStart === false) {
    void stat(path).then((s) => { offset = s.size }).catch(() => undefined)
  } else {
    void pump()
  }

  try {
    watcher = watch(path, () => { void pump() })
    watcher.on('error', () => {})
  } catch {
    watcher = null
  }
  pollTimer = setInterval(() => { void pump() }, POLL_INTERVAL_MS)

  return {
    close() {
      if (closed) return
      closed = true
      if (watcher) { try { watcher.close() } catch {} ; watcher = null }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    },
  }
}
```
**Note:** only the module home changes (`supervisor/src/usage/`); signature and internals unchanged. `POLL_INTERVAL_MS = 500` should be reused as-is per RESEARCH.md Open Question 2's recommendation.

---

### `supervisor/src/usage/pty-usage-emitter.ts` (NEW)

**Analog A — parse shape (reference only, do NOT reuse the function itself):** `hub/src/telegram/transcript/claude-adapter.ts` `mapClaudeRecord` — shows the established "skip on unknown/malformed, never throw" posture and the `onParseError`-style skip-counter convention (`hub/test/transcript-adapter-claude.test.ts:20-62` demonstrates the exact skip semantics to mirror: unknown record type → skip + count; missing required field → skip, never emit optimistically).

**Analog B — usage_event emission shape:** `supervisor/src/runners/session-bridge.ts:471-490` (existing `result`-event emitter, stream-json path):
```typescript
if (this.sessionId && e.usage) {
  this.sendToHub({
    type: 'usage_event',
    session_id: this.sessionId,
    model: e.model ?? null,
    input_tokens: e.usage.input_tokens ?? 0,
    output_tokens: e.usage.output_tokens ?? 0,
    cache_creation_input_tokens: e.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: e.usage.cache_read_input_tokens ?? 0,
    cost_usd: e.cost ?? 0,
    cost_source: e.cost_from_sdk ? 'sdk' : 'estimated',
    ts: new Date().toISOString(),
  })
}
```
The new PTY emitter mirrors this shape but adds `runner_type: 'pty-interactive'` and always sets `cost_source: 'estimated'` (per RESEARCH.md Open Question 1 — transcript has no `total_cost_usd` field, so let the existing `estimateCostUsd()` fallback in `hub/src/usage/pricing.ts` compute it hub-side, same as the stream-json path already does when the SDK omits cost).

**Extraction logic (new, reference shape from RESEARCH.md's Code Examples — not an existing function, but the exact verified record shape):**
```typescript
interface TranscriptUsageRecord {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  model: string | null
}

function extractUsage(record: unknown): TranscriptUsageRecord | null {
  if (!record || typeof record !== 'object') return null
  const r = record as any
  if (r.type !== 'assistant') return null
  const usage = r.message?.usage
  if (!usage || typeof usage !== 'object') return null
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    model: typeof r.message?.model === 'string' ? r.message.model : null,
  }
}
```

**Error handling pattern:** wrap `JSON.parse` + `extractUsage` per line in try/catch exactly as `tail.ts`'s `onParseError` callback does — a bad line is skipped, never fatal (mirrors `mapClaudeRecord`'s "unknown type → skip + count, never crash" posture, ASVS V5 requirement per RESEARCH.md Security Domain).

---

### `supervisor/src/runners/claude-pty-bridge.ts` (MODIFY — wire tail lifecycle)

**Analog:** itself. `start()` (lines 94-119) and `kill()` (lines 134-139) are the exact two lifecycle hooks to extend — start the tailer inside/alongside `start()`, close it inside/alongside `kill()`. Mirrors the file's own documented DETACH-vs-KILL distinction (comment block lines 30-33): a socket close alone (`detach`) should NOT close the tailer (the PTY — and its transcript writes — are still alive on the Rust host); only an explicit `kill()` should close the tailer.

```typescript
// start() — existing, lines 94-119 — add tail spawn near the `sendFrame({t:'spawn',...})` call
start(opts: PtyBridgeOpts): void {
  this.opts = opts
  this.killed = false
  const port = readPtyHostPort()
  this.sock = opts.connectFactory ? opts.connectFactory(port) : connect({ host: '127.0.0.1', port })
  // ... existing socket wiring ...
  this.sendFrame({ t: 'spawn', session_id: opts.sessionId, cli: opts.cli ?? 'claude', cwd: opts.cwd, /* ... */ })
}

// kill() — existing, lines 134-139 — idempotent, mirror this guard for tail teardown
kill(): void {
  if (this.killed) return
  this.killed = true
  try { this.sendFrame({ t: 'kill' }) } catch {}
  try { this.sock?.end() } catch {}
}
```

---

### `supervisor/src/runners/types.ts` (MODIFY — extend `usage_event` type)

**Analog:** itself, existing `usage_event` variant (cited in RESEARCH.md Pattern 2). Copy the additive-optional-field convention used elsewhere in this codebase for exactly this situation (Phase 18's `programmatic_credit`, Phase 16's `runner_type` on `sessions`):
```typescript
| {
    type: 'usage_event'
    session_id: string
    model: string | null
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    cost_usd: number
    cost_source: 'sdk' | 'estimated'
    ts: string
    runner_type?: 'stream-json' | 'pty-interactive'  // NEW, optional; hub defaults to 'stream-json' when absent
  }
```

---

### `hub/src/ws/agent.ts` (MODIFY — thread `runner_type` through)

**Analog:** itself, existing `usage_event` handler (`hub/src/ws/agent.ts:756-794`):
```typescript
// P2 usage ledger — persist per-turn token + cost from the supervisor bridge.
// RECORD only; the cost cap (P3) is intentionally NOT consulted here.
if (msg.type === 'usage_event') {
  if (!ws.data.userId) return
  try {
    const { recordTokenUsage } = await import('../db/token-usage-dal.ts')
    const { estimateCostUsd } = await import('../usage/pricing.ts')
    let costUsd = msg.cost_usd
    let costSource: 'sdk' | 'estimated' = msg.cost_source
    if (costSource === 'estimated' || !(costUsd > 0)) {
      if (costSource !== 'sdk') {
        costUsd = estimateCostUsd(msg.model ?? null, { /* 4 buckets */ })
        costSource = 'estimated'
      }
    }
    await recordTokenUsage({
      userId: ws.data.userId,
      sessionId: ws.data.sessionId ?? null,
      model: msg.model ?? null,
      inputTokens: msg.input_tokens,
      outputTokens: msg.output_tokens,
      cacheCreationInputTokens: msg.cache_creation_input_tokens,
      cacheReadInputTokens: msg.cache_read_input_tokens,
      costUsd,
      costSource,
      // NEW: runnerType: msg.runner_type ?? 'stream-json',
    })
  } catch (err: any) {
    console.error('[agent] usage_event handler failed', err?.message)
  }
  return
}
```
Change is a one-line addition to the `recordTokenUsage(...)` call object — default `msg.runner_type ?? 'stream-json'` for backward compat with older supervisors (covered by the extended `hub/test/usage-event-handler.test.ts`).

**Error handling pattern:** unchanged — keep the existing try/catch-log-and-return; never let a malformed/old-shape frame throw past the handler.

---

### `hub/src/db/token-usage-dal.ts` (MODIFY — add `runnerType` param)

**Analog:** itself, `recordTokenUsage()` (lines 13-68):
```typescript
export interface TokenUsageInput {
  userId: string
  sessionId: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  costUsd: number
  costSource: 'sdk' | 'estimated'
  // NEW: runnerType?: 'stream-json' | 'pty-interactive'  // additive, optional, default 'stream-json'
}

export async function recordTokenUsage(u: TokenUsageInput): Promise<{ id: string }> {
  const model = u.model ?? null
  const dailyModel = model ?? ''
  const rows = await sql<{ id: string }[]>`
    INSERT INTO token_usage (
      user_id, session_id, model,
      input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens,
      cost_usd, cost_source
      -- NEW: , runner_type
    ) VALUES (
      ${u.userId}, ${u.sessionId}, ${model},
      ${u.inputTokens}, ${u.outputTokens},
      ${u.cacheCreationInputTokens}, ${u.cacheReadInputTokens},
      ${u.costUsd}, ${u.costSource}
      -- NEW: , ${u.runnerType ?? 'stream-json'}
    )
    RETURNING id
  `
  // ... token_usage_daily upsert unchanged (Pitfall 5: PK stays (user_id, day, model); explicit
  // decision NOT to extend to runner_type in this phase, per RESEARCH.md) ...
}
```
**Note:** `token_usage_daily` upsert block (lines 47-66) stays untouched per RESEARCH.md Pitfall 5 — extending its PK is explicitly out of scope for Phase 1.

---

### `hub/src/db/schema.sql` (MODIFY — additive column)

**Analog:** itself, the exact established pattern at `hub/src/db/schema.sql:635-642` (`sessions.runner_type`):
```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runner_type TEXT NOT NULL DEFAULT 'stream-json';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name='sessions_runner_type_check') THEN ALTER TABLE sessions ADD CONSTRAINT sessions_runner_type_check CHECK (runner_type IN ('stream-json','pty-interactive')); END IF; END $$;
```

**Apply to `token_usage` table** (insert immediately after the existing block at `schema.sql:1311-1325`, per RESEARCH.md's Code Examples section — this is the exact SQL to add, verbatim):
```sql
-- ── PTYCAP Phase 1: per-row runner_type tag on the usage ledger ──────────────
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS runner_type TEXT NOT NULL DEFAULT 'stream-json';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'token_usage_runner_type_check'
  ) THEN
    ALTER TABLE token_usage ADD CONSTRAINT token_usage_runner_type_check
      CHECK (runner_type IN ('stream-json', 'pty-interactive'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_token_usage_user_runner_type ON token_usage(user_id, runner_type, created_at DESC);
```
**Invariant:** `schema.sql` re-runs in full every hub boot — idempotent DDL only (`ADD COLUMN IF NOT EXISTS`, `IF NOT EXISTS` check-constraint guard). No inline backfill; N/A here since this is a new nullable-with-default column on new/existing rows alike.

---

### Test files (NEW / EXTEND)

**Analog:** `hub/test/transcript-adapter-claude.test.ts` — fixture-driven adapter test pattern to copy structurally:
```typescript
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// import subject under test ...

const FIXTURE = join(import.meta.dir, 'fixtures', 'claude-transcript.jsonl')

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('<subject> (SC-N)', () => {
  it('maps each known record type and SKIPS the unknown one', () => {
    const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n')
    let skipped = 0
    // ... map, assert kinds present, assert skip count exact ...
  })
})
```
Use this pattern for:
- `supervisor/test/pty-usage-tail.test.ts` — write a fake growing JSONL fixture (append lines with a `wait()` between writes) and assert a `usage_event`-shaped callback fires per assistant-with-usage record while the file is still being appended to (SC-1, "mid-turn observable").
- `hub/test/token-usage-runner-type.test.ts` — unit test against `recordTokenUsage()` directly: two calls with different `runnerType` produce two distinguishable rows; a third invalid value is rejected by the DB check constraint (SC-2).
- `hub/test/pty-usage-midflight-visibility.test.ts` — integration test: N incremental `recordTokenUsage()` calls, assert `getTodayTokenTotal()` reflects the cumulative sum without a session-close event (SC-3).
- `hub/test/usage-event-handler.test.ts` (existing — extend, don't recreate) — add a case asserting an old-shape frame (no `runner_type` field) still records with `runner_type='stream-json'` default (backward-compat regression).

**Analog for the optional guard canary:** `supervisor/test/no-legacy-agent-spawn.test.ts` — cited directly by RESEARCH.md as the style for `hub/test/no-hub-side-transcript-fs.test.ts`: a cheap grep-based static test asserting no new `hub/src/**` file calls `fs.existsSync`/`readFileSync` against a `homedir()`-derived path (Pitfall 1 guard).

## Shared Patterns

### Additive, optional, defaulted schema/protocol changes
**Source:** `hub/src/db/schema.sql:635-642` (`sessions.runner_type`) and the `usage_event` WS type itself.
**Apply to:** `schema.sql` (token_usage.runner_type), `supervisor/src/runners/types.ts` (usage_event.runner_type), `hub/src/db/token-usage-dal.ts` (TokenUsageInput.runnerType).
**Rule:** every new field is optional with a safe default (`'stream-json'`) so an older supervisor build never crashes a newer hub and vice versa — never a breaking change to an existing message/table shape.

### Parse-error-tolerant line processing
**Source:** `hub/src/telegram/transcript/tail.ts` (`onParseError` callback) and `hub/src/telegram/transcript/claude-adapter.ts` (`mapClaudeRecord`'s skip-and-count posture, verified by `hub/test/transcript-adapter-claude.test.ts:51-62`, "no request id ⇒ skipped" / "non-object record ⇒ skipped").
**Apply to:** `pty-usage-emitter.ts`'s per-line JSON parse + `extractUsage()` — malformed/adversarial lines must be skipped, never fatal (ASVS V5, RESEARCH.md Security Domain).

### RECORD-only, never-gate-here posture
**Source:** `hub/src/ws/agent.ts:757-758` comment ("P2 usage ledger... RECORD only; the cost cap (P3) is intentionally NOT consulted here").
**Apply to:** all Phase 1 code — this phase writes to the ledger only; `dailyTokenCapGate`/`dailyCostCapGate` extension for PTY is explicitly Phase 2, out of scope here.

### Host-boundary discipline (Pitfall 1)
**Source:** RESEARCH.md itself, reinforced by `hub/src/telegram/transcript/` being flag-gated OFF in Coolify (`REMO_TELEGRAM_TRANSCRIPT_TAIL`).
**Apply to:** never add a direct `fs`/`homedir()`-derived file read under `hub/src/**` for this phase — all transcript file access lives in `supervisor/src/usage/`, crossing the host boundary only via the existing `/ws/agent` `usage_event` frame.

## No Analog Found

None — every file in this phase has a direct, exact, or role-matched analog already shipped in this codebase (this phase is explicitly a "port + extend existing primitives" phase per RESEARCH.md's Don't-Hand-Roll section, not new-capability work).

## Metadata

**Analog search scope:** `hub/src/telegram/transcript/`, `hub/src/ws/agent.ts`, `hub/src/db/{token-usage-dal.ts,schema.sql}`, `supervisor/src/runners/{session-bridge.ts,claude-pty-bridge.ts,types.ts}`, `hub/test/transcript-adapter-claude.test.ts`, `supervisor/test/no-legacy-agent-spawn.test.ts` (referenced, not re-read — cited by RESEARCH.md).
**Files scanned:** 8 read directly this pass + RESEARCH.md's own prior verification (cited Sources section) for files not re-read here (`pty_host.rs`, `dispatch/gates.ts`, `usage/{store,pricing,programmatic-leak}.ts`, `ext/supervisor-read.ts`, `commands/session-read.ts`).
**Pattern extraction date:** 2026-07-27
