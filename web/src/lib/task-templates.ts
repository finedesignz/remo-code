// Prompt templates auto-populated into the "Notes" field when a user
// picks one of the structured task types in the schedule editor. Users
// can edit freely; templates only pre-fill on first selection (or when
// switching between template-backed types without manual edits).

import type { TaskType } from '../hooks/useSchedules'

export const CONTINUE_DEV_TEMPLATE = `# AUTONOMOUS PROJECT CONTINUATION RUN

## CONFIG (edit per scheduled task)
PROJECT_TYPE: <web-app | tauri | api | service | cli>
DEPLOY_TARGET: <coolify | tauri-multi-platform | none>
COOLIFY_APP_NAME: <coolify-app-slug or "n/a">
NOTIFY_EMAIL: <your@email>

## NON-NEGOTIABLE RULES
1. DELEGATE EVERYTHING. Main thread = orchestrator only. Every unit of work goes to a specialist subagent via the Task tool. Use run_in_background: true whenever phases can parallelize.
2. NEVER ASK QUESTIONS. Dispatch the matching specialist subagent and act on its answer.
3. NEVER STOP MID-FLOW (pre-v1). Post-v1, stop ONLY after exactly one feature has been fully reviewed, version-bumped, and deployed clean.
4. APPEND TO THE RUNNING LOG after every phase/feature: \`.claude/autonomous/LOG.md\`.
5. Respect all global rules in ~/.claude/CLAUDE.md (Titanium Licensing, Postgres on Coolify, emails4agents, gateway pair, design tokens, fresh-branch-per-feature rule #19, etc.).
6. POST-V1 UI CHANGE RULE: ANY non-trivial UI change MUST be reviewed by BOTH a Frontend Designer / UX specialist AND the Backend Architect (if state/data/APIs are touched) BEFORE implementation. Trivial fixes (typo, single-class nudge) bypass.
7. BRANCH HYGIENE (rule #19): Before any new feature/phase, check \`git branch --show-current\`. If on \`main\` or unrelated branch → create fresh \`feat/<slug>\`, \`fix/<slug>\`, or \`phase-<NN>-<slug>\`. One branch = one concern = one PR.

## MODE DETECTION
\`git tag --list 'v1.*' 'v[2-9]*'\`. No v1+ tag → PRE-V1. Else → POST-V1.

## STARTUP SEQUENCE
1. Ensure \`.claude/autonomous/\` exists. Add to \`.gitignore\` if missing.
2. If \`.planning/codebase/\` missing or >7 days old → \`/gsd-map-codebase\` first.
3. If \`.planning/plan.md\` missing → fresh branch \`phase-00-bootstrap\`, then \`/gsd-new-project\`.
4. Otherwise → resume from next pending phase on correct phase branch.
5. Read \`.claude/autonomous/LOG.md\` for prior state + live TODO.

## DOC LOCATIONS
- **Committed:** \`CHANGELOG.md\`, \`docs/FEATURE-CATALOG.md\`, \`docs/BACKLOG.md\`
- **Local-only (gitignored \`.claude/autonomous/\`):** \`LOG.md\`, \`BLOCKERS.md\`, \`dep-reports/<ISO>.md\`
- **GSD-owned (\`.planning/\`):** \`plan.md\`, \`codebase/*\`

## PRE-V1 EXECUTION
For each pending phase:
  a. BRANCH: phase-specific (\`phase-<NN>-<slug>\`).
  b. PRE-FLIGHT: Backend Architect subagent reviews.
  c. IMPLEMENT: specialist subagent with goal, paths, acceptance criteria. Karpathy discipline.
  d. QC GATE: build, tests, lint, type-check. Max 3 fix attempts; else BLOCKERS + email + exit.
  e. DOCS: README, CLAUDE.md, docs/, codebase snapshots.
  f. COMMIT + PUSH + PR.
  g. LOG. Next phase.
After all phases → DEPLOYMENT → V1 PUBLISH GATE.

## DEPLOYMENT
- **Coolify:** infra agent. Log-watcher tails ≥5 min. Errors → fix → redeploy. Smoke-test live URL.
- **Tauri:** build Win/Mac/iOS/Android. Per-platform fix subagent max 3 attempts.

## V1 PUBLISH GATE (one-time)
1. Version = \`1.0.0\` across all sources.
2. Wire UNIVERSAL APP PATTERNS.
3. Tag \`v1.0.0\`, push.
4. Catalog-builder → \`docs/FEATURE-CATALOG.md\`.
5. Initialize \`CHANGELOG.md\`.
6. Email NOTIFY_EMAIL.
7. Exit.

## UNIVERSAL APP PATTERNS
1. \`APP_VERSION\` constant from package.json / tauri.conf.json.
2. **About modal** shows app name, version, build date, CHANGELOG link, support link.
3. **Profile dropdown** has "About" link.
4. **Settings footer** shows \`v{APP_VERSION} · About\`.
5. **Update detection:** web service worker checks \`/version.json\`; Tauri \`@tauri-apps/plugin-updater\`.
6. **CHANGELOG.md** updated on every bump.
7. **Version endpoint:** web \`/version.json\`; Tauri standard updater JSON.

## POST-V1 EXECUTION (one feature per session)
1. BRANCH: fresh \`fix/feature-qc-<slug>\` off main.
2. Pre-flight: \`npm outdated\` (+ \`cargo outdated\`) → dep-reports.
3. Pick next feature from FEATURE-CATALOG: Universal Patterns empty FIRST, then any empty Last QC, then oldest. If all reviewed → reset cycle.
4. Feature-QC subagent runs PER-FEATURE QC CHECKLIST.
5. Non-trivial UI change → enforce rule #6.
6. Changes made → docs/writer → version-bump → deploy → log-watch.
7. Update FEATURE-CATALOG Last QC.
8. Commit + push + PR.
9. Append to LOG.md.
10. Email NOTIFY_EMAIL.
11. Exit.

## PER-FEATURE QC CHECKLIST
- [ ] Scope vs spec
- [ ] No stale/dead code
- [ ] Security (authn/authz, input validation, no leaked secrets, injection protection, rate limiting, gateway-pair secrets)
- [ ] CRUD completeness
- [ ] Architecture spec adherence
- [ ] Design tokens (subtle, blue accent, no ad-hoc hex)
- [ ] Accessibility (keyboard, focus rings, ARIA, AA contrast)
- [ ] Error handling + observability
- [ ] Tests passing
- [ ] Performance (no N+1, sane bundle delta)
- [ ] Universal patterns wired
- [ ] Dependency hygiene
- [ ] Telemetry events
- [ ] Empty / loading / error / offline states
- [ ] Permissions / multi-tenant isolation
- [ ] Mobile responsiveness or platform parity

## VERSION BUMPING (semver)
- **MAJOR** — breaking changes, removed features, forced re-login/migrate.
- **MINOR** — new feature/endpoint/permission, non-breaking arch.
- **PATCH** — bug fixes, no-behavior dep updates, copy/UI tweaks.
Update all version sources. Tag \`vX.Y.Z\`. Push. Append CHANGELOG.

## EMAIL (emails4agents)
\`POST /v1/messages/send\` with \`X-API-Key\`. Env: \`E4A_API_KEY\`, \`E4A_BASE_URL=https://api.emails4agents.com\`, \`E4A_INBOX_ID\`.

## STOP CONDITIONS
- PRE-V1: same QC/deploy failure 3× → BLOCKERS + email + exit.
- POST-V1: stop AFTER one feature reviewed, bumped, deployed clean.
- Any mode: structural decision exceeding authority → BLOCKERS + email + exit.

Begin now.
`

export const LOG_CHECK_TEMPLATE = `# COOLIFY LOG CHECK RUN

## CONFIG (edit per scheduled task)
COOLIFY_APP_NAME: <coolify-app-slug>
COOLIFY_APP_UUID: <coolify-uuid>
TAIL_WINDOW_MINUTES: 60
NOTIFY_EMAIL: <your@email>
SEVERITY_THRESHOLD: warn   # info | warn | error

## NON-NEGOTIABLE RULES
1. DELEGATE log fetch + analysis to ONE specialist subagent (general-purpose or infra).
2. NEVER ASK QUESTIONS.
3. READ-ONLY by default. Do NOT redeploy/restart/edit unless CRITICAL + unambiguous + reversible.
4. Respect global rules in ~/.claude/CLAUDE.md.
5. APPEND to \`.claude/autonomous/log-checks/<ISO>.md\` — gitignored.

## STARTUP
1. Ensure \`.claude/autonomous/log-checks/\` exists. \`.gitignore\` if missing.
2. Dispatch log-watcher subagent.

## LOG-WATCHER SUBAGENT BRIEF
- Pull last TAIL_WINDOW_MINUTES of Coolify logs for COOLIFY_APP_UUID.
- Tools: Coolify API (token in \`~/.claude/secrets/services.json\` under \`coolify.token\`, URL \`https://coolify.titaniumlabs.us\`). \`GET /api/v1/applications/{uuid}/logs\`. Fall back to \`infra\` agent.
- Classify each pattern: CRITICAL (crashes, OOM, 5xx storms, DB loss, auth failures), ERROR (recurring 4xx/5xx, stack traces, failed jobs), WARN (deprecations, slow queries, retries, throttling), INFO (normal).
- DEDUPE: collapse identical messages with first + last timestamps.
- COMPARE to previous report. Flag NEW vs RECURRING.
- Write report to \`.claude/autonomous/log-checks/<ISO>.md\`.

## ACTION RULES
1. Finding ≥ SEVERITY_THRESHOLD → email NOTIFY_EMAIL with full report.
2. CRITICAL → append to \`.claude/autonomous/BLOCKERS.md\`. Do NOT auto-fix.
3. Degraded trend 2 runs → separate \`[log-check] DEGRADATION\` email.
4. Below threshold → silent success.

## EMAIL (emails4agents)
\`POST /v1/messages/send\` with \`X-API-Key\`. Env: \`E4A_API_KEY\`, \`E4A_BASE_URL=https://api.emails4agents.com\`, \`E4A_INBOX_ID\`.

## STOP CONDITIONS
- Coolify API unreachable 3× → email + exit.
- Malformed logs → BLOCKERS + email + exit.
- Normal: report written, email if threshold tripped, exit clean.

Begin now.
`

export const SECURITY_SCAN_TEMPLATE = `# SECURITY SCAN RUN

## CONFIG (edit per scheduled task)
PROJECT_TYPE: <web-app | tauri | api | service | cli>
DEPLOY_TARGET: <coolify | tauri-multi-platform | none>
COOLIFY_APP_NAME: <coolify-app-slug or "n/a">
LIVE_URL: <https://app.example.com or "n/a">
NOTIFY_EMAIL: <your@email>
SEVERITY_THRESHOLD: medium   # low | medium | high | critical

## NON-NEGOTIABLE RULES
1. DELEGATE every scan dimension to a specialist subagent. Run in PARALLEL with run_in_background: true.
2. NEVER ASK QUESTIONS.
3. READ-ONLY. Do NOT auto-patch. ONE exception: rotate clearly-leaked secrets via gateway pair.
4. Respect global rules in ~/.claude/CLAUDE.md.
5. APPEND to \`.claude/autonomous/security-scans/<ISO>.md\` — gitignored.
6. BRANCH HYGIENE (rule #19): emergency fixes on fresh \`fix/security-<slug>\` branch — never main directly.

## STARTUP
1. Ensure \`.claude/autonomous/security-scans/\` exists. \`.gitignore\`.
2. Confirm on \`main\` (read-only). Switch if not.
3. \`git pull origin main\`.
4. Dispatch scan subagents IN PARALLEL.

## SCAN DIMENSIONS

### 1. Secret-Scanner
- \`gitleaks detect\` (or \`trufflehog\`) full history. API keys, tokens, private keys, DB creds, OAuth, committed \`.env*\`.
- Cross-check vs \`~/.claude/secrets/services.json\` + gateway-pair. Live = CRITICAL.

### 2. Dependency-Vulnerability
- \`npm audit --json\` (+ \`cargo audit\`, \`pip-audit\`). Cross-ref OSV/GitHub Advisory. Direct HIGH/CRITICAL CVE = report.

### 3. Code-Security (Security Engineer agent)
- OWASP Top 10 patterns: SQLi, XSS sinks, SSRF, CSRF gaps, auth bypass, authz holes (no user-scope WHERE), insecure deserialization, prototype pollution, command injection.
- Verify Titanium Licensing wired: no parallel auth, no direct Stripe, no local passwords.

### 4. Infrastructure-Config (if Coolify)
- Pull Coolify app config. Only gateway-pair vars + PORT. TLS enforced, DB SSL, no extra public ports, healthcheck configured.

### 5. Live-Surface (if LIVE_URL set)
- Headers: HSTS, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- TLS: cert validity, expiry >30d, modern ciphers.
- Probe \`/admin\`, \`/.git\`, \`/.env\`, \`/api/internal\` — should 404/401.

## CONSOLIDATION
Aggregate into \`.claude/autonomous/security-scans/<ISO>.md\`. Severity summary, trend vs previous, findings by severity, remediation suggestions.

## ACTION RULES
1. Finding ≥ SEVERITY_THRESHOLD → email NOTIFY_EMAIL.
2. CRITICAL → BLOCKERS entry. SECRET-LEAK → secret-rotation subagent on \`fix/security-rotate-<slug>\` branch. Rotate via gateway pair. PR + email user.
3. HIGH/MEDIUM/LOW → BLOCKERS + BACKLOG for next "Continue Dev" run.
4. Degrading trend → separate \`[sec-scan] DEGRADATION\` email.
5. Clean → silent success.

## EMAIL (emails4agents)
\`POST /v1/messages/send\` with \`X-API-Key\`. Env: \`E4A_API_KEY\`, \`E4A_BASE_URL=https://api.emails4agents.com\`, \`E4A_INBOX_ID\`.

## STOP CONDITIONS
- Scan subagent fails 3× → partial report, email "incomplete", exit.
- Gateway pair unreachable for rotation → CRITICAL email, BLOCKERS, exit.
- Normal: report written, email if threshold tripped, exit clean.

Begin now.
`

// Phase 11: legacy continue_dev → dev, legacy security_scan → security.
// log_check is unchanged. These web previews are non-authoritative; the
// hub `.md` files under hub/src/scheduler/prompts/<workflow>/<step>.md are
// source-of-truth.
export const TASK_TEMPLATES: Partial<Record<TaskType, string>> = {
  dev: CONTINUE_DEV_TEMPLATE,
  log_check: LOG_CHECK_TEMPLATE,
  security: SECURITY_SCAN_TEMPLATE,
}

/** True if notes is empty or exactly matches any known template (user hasn't edited). */
export function isReplaceableNotes(notes: string): boolean {
  if (!notes.trim()) return true
  for (const tpl of Object.values(TASK_TEMPLATES)) {
    if (tpl && notes === tpl) return true
  }
  return false
}
