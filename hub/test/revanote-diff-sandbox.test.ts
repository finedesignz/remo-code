/**
 * Diff-sandbox unit tests. Pure-function over unified diff text — no shell.
 */
import { describe, expect, test } from 'bun:test'
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

const envFile = `diff --git a/.env b/.env
index 111..222 100644
--- a/.env
+++ b/.env
@@ -1 +1 @@
-FOO=bar
+FOO=baz
`

const secretContent = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,2 @@
 export const x = 1
+const AWS_SECRET_KEY = 'abc'
`

const lockfileChurn = `diff --git a/package-lock.json b/package-lock.json
index 111..222 100644
--- a/package-lock.json
+++ b/package-lock.json
` + Array.from({ length: 60 }, (_, i) => `+  "line${i}": "x",`).join('\n') + '\n'

const depBump = `diff --git a/package.json b/package.json
index 111..222 100644
--- a/package.json
+++ b/package.json
@@ -10,7 +10,8 @@
   "dependencies": {
     "react": "^18.0.0",
-    "lodash": "^4.17.20"
+    "lodash": "^4.17.21",
+    "axios": "^1.6.0"
   },
   "devDependencies": {
     "typescript": "^5.0.0"
`

describe('analyzeDiff', () => {
  test('clean CSS-only diff passes', () => {
    const a = analyzeDiff(cssOnly)
    expect(a.ok).toBe(true)
    expect(a.blockedReasons).toEqual([])
    expect(a.fileSummary.files).toEqual(['src/styles.css'])
    expect(a.diffHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('.env path → blocked', () => {
    const a = analyzeDiff(envFile)
    expect(a.ok).toBe(false)
    expect(a.blockedReasons.join(';')).toMatch(/blocked_path:\.env/)
  })

  test('secret regex in content → blocked', () => {
    const a = analyzeDiff(secretContent)
    expect(a.ok).toBe(false)
    expect(a.blockedReasons.some((r) => r.startsWith('blocked_content'))).toBe(true)
  })

  test('lockfile >50 line churn → soft-flagged but not blocked', () => {
    const a = analyzeDiff(lockfileChurn)
    expect(a.ok).toBe(true)
    expect(a.softFlags.some((f) => f.startsWith('lockfile_churn'))).toBe(true)
  })

  test('package.json deps change → soft-flagged', () => {
    const a = analyzeDiff(depBump)
    expect(a.ok).toBe(true)
    expect(a.softFlags.some((f) => f.startsWith('dependency_change'))).toBe(true)
  })

  test('empty diff: ok, no flags, hash is sha256 of empty string', () => {
    const a = analyzeDiff('')
    expect(a.ok).toBe(true)
    expect(a.fileSummary.files).toEqual([])
    // sha256("") = e3b0c44...
    expect(a.diffHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
