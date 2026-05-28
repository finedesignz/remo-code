/**
 * Risk classifier unit tests.
 */
import { describe, expect, test } from 'bun:test'
import { classifyRisk } from '../src/revanote/risk-classifier'
import { analyzeDiff } from '../src/revanote/diff-sandbox'

const cssOnly = `diff --git a/src/styles.css b/src/styles.css
index abc..def 100644
--- a/src/styles.css
+++ b/src/styles.css
@@ -1,3 +1,3 @@
-.btn { color: red; }
+.btn { color: blue; }
 .other { margin: 0; }
`

const migration = `diff --git a/migrations/0042_add_col.sql b/migrations/0042_add_col.sql
new file mode 100644
index 0..1
--- /dev/null
+++ b/migrations/0042_add_col.sql
@@ -0,0 +1,2 @@
+ALTER TABLE foo ADD COLUMN bar text;
`

const newExport = `diff --git a/hub/src/foo.ts b/hub/src/foo.ts
index 111..222 100644
--- a/hub/src/foo.ts
+++ b/hub/src/foo.ts
@@ -1,2 +1,5 @@
 export const x = 1
+export function newPublicApi(): void {
+  return
+}
`

const envExample = `diff --git a/.env.example b/.env.example
index 111..222 100644
--- a/.env.example
+++ b/.env.example
@@ -1 +1,2 @@
 FOO=bar
+NEW_REQUIRED_VAR=
`

const copyEditOnly = `diff --git a/src/Welcome.tsx b/src/Welcome.tsx
index 111..222 100644
--- a/src/Welcome.tsx
+++ b/src/Welcome.tsx
@@ -1,3 +1,3 @@
 export function Welcome() {
-  return <h1 className="text-2xl">Hello</h1>
+  return <h1 className="text-3xl">Hello, world</h1>
 }
`

describe('classifyRisk', () => {
  test('CSS-only diff → minor', async () => {
    const r = await classifyRisk(analyzeDiff(cssOnly))
    expect(r.riskClass).toBe('minor')
  })

  test('migration file → major', async () => {
    const r = await classifyRisk(analyzeDiff(migration))
    expect(r.riskClass).toBe('major')
    expect(r.rationale).toMatch(/major_path|migrations/i)
  })

  test('new exported function in hub/src/* → breaking', async () => {
    const r = await classifyRisk(analyzeDiff(newExport))
    expect(r.riskClass).toBe('breaking')
    expect(r.rationale).toMatch(/exports_changed/)
  })

  test('.env.example change → breaking', async () => {
    const r = await classifyRisk(analyzeDiff(envExample))
    // .env path is in BLOCKED_PATH_PATTERNS so diff-sandbox would normally block.
    // We bypass diff-sandbox here to test the classifier in isolation. In the
    // real pipeline this case never reaches the classifier — but if it did,
    // the classifier still flags it breaking.
    expect(r.riskClass).toBe('breaking')
  })

  test('copy-edit only inside tsx (className tweak) → minor', async () => {
    const r = await classifyRisk(analyzeDiff(copyEditOnly))
    expect(r.riskClass).toBe('minor')
  })
})
