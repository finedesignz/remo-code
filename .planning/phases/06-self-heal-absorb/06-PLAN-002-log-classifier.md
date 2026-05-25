---
phase: 06-self-heal-absorb
plan: 002
type: execute
wave: 1
depends_on: []
files_modified:
  - hub/src/scheduler/log-classifier.ts
  - hub/test/log-classifier.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "classifyLog() returns hasErrors=false on clean logs"
    - "classifyLog() detects all 16 patterns ported from coolify-ai-monitor"
    - "Each match is tagged with severity (low/med/high)"
  artifacts:
    - path: "hub/src/scheduler/log-classifier.ts"
      provides: "classifyLog(text) regex pre-filter utility"
      exports: ["classifyLog", "LogMatch", "Severity"]
    - path: "hub/test/log-classifier.test.ts"
      provides: "Unit tests covering each pattern + severity tagging"
  key_links:
    - from: "hub/src/scheduler/log-classifier.ts"
      to: "hub/src/scheduler/senders/coolify.ts (plan 003)"
      via: "called after fetchLogs to gate post-run actions"
---

<objective>
Create the regex error pre-filter utility used to gate LLM spend on `log_check` runs. Pure function, no side effects, fully unit-testable. Wiring into `senders/coolify.ts` happens in plan 003.

Purpose: Cost-cap preservation — skip post-run actions entirely when no errors detected.
Output: `hub/src/scheduler/log-classifier.ts` + `hub/test/log-classifier.test.ts`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement classifyLog with 16-pattern set + severity tagging</name>
  <files>hub/src/scheduler/log-classifier.ts, hub/test/log-classifier.test.ts</files>
  <read_first>
    - C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js (lines 28-87 — ERROR_PATTERNS array + detectErrors helper, reference only)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md (decisions §"Regex pre-filter (G3)" + specifics §"Regex pattern port")
  </read_first>
  <behavior>
    - Test: empty string → `{ hasErrors: false, matches: [] }`
    - Test: `"server started ok"` (no error tokens) → `hasErrors: false`
    - Test: line containing `ECONNREFUSED` → `hasErrors: true`, one match with severity `'med'`
    - Test: line containing `out of memory` (case-insensitive) → severity `'high'`
    - Test: line containing `segfault` → severity `'high'`
    - Test: line containing `uncaught exception` → severity `'high'`
    - Test: line containing `TypeError: x is undefined` → severity `'med'`
    - Test: 100-line log with two error lines → matches.length === 2, each with `line` field carrying the raw matched line
    - Test: pattern names returned are stable identifiers (string), not regex source — so callers can group
  </behavior>
  <action>Create `hub/src/scheduler/log-classifier.ts` exporting: `type Severity = 'low' | 'med' | 'high'`; `interface LogMatch { pattern: string; line: string; severity: Severity }`; `function classifyLog(text: string): { hasErrors: boolean; matches: LogMatch[] }`. Define a module-local `PATTERNS: Array<{ name: string; re: RegExp; severity: Severity }>` with exactly 16 entries matching CONTEXT.md specifics §"Regex pattern port" — names: `error`, `econnrefused`, `etimedout`, `syntax_error`, `type_error`, `reference_error`, `uncaught_exception`, `unhandled_rejection`, `fatal`, `segfault`, `oom`, `eacces`, `eaddrinuse`, `connection_refused`, `permission_denied`, `module_not_found`. Severity assignment: `high` for `uncaught_exception`, `unhandled_rejection`, `fatal`, `segfault`, `oom`; `med` for everything else; never `low` in this iteration (reserved for future tuning). Implementation: split text on `/\r?\n/`, iterate lines, for each line iterate PATTERNS and push every matching pattern as a LogMatch (one line can produce multiple matches). Cap total matches at 50 to avoid unbounded arrays — once 50 reached, stop scanning. `hasErrors = matches.length > 0`. Also create `hub/test/log-classifier.test.ts` using `bun:test` (`import { test, expect } from 'bun:test'`) covering the behaviors above. The test file must not require a DB.</action>
  <verify>
    <automated>cd hub ; bun test test/log-classifier.test.ts</automated>
  </verify>
  <done>All tests green. classifyLog is a pure function with no imports beyond standard types. 16 named patterns confirmed via test assertion that the pattern name set equals the expected set.</done>
</task>

</tasks>

<verification>
- `bun test hub/test/log-classifier.test.ts` exits 0.
- `grep -c "name:" hub/src/scheduler/log-classifier.ts` ≥ 16.
</verification>

<success_criteria>
- classifyLog is pure, side-effect free, no DB calls.
- All 16 patterns present and severity-tagged per CONTEXT.md.
- Test coverage proves each severity tier and the empty/clean-log paths.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-002-SUMMARY.md` when done.
</output>
