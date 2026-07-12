// Global test preload (configured via hub/bunfig.toml [test] preload).
//
// Bun's `mock.module()` is process-global and persists across test files
// (first-write-wins). Without teardown, a partial mock registered by one file
// shadows the real module — or another file's mock — for every subsequent file
// in the same `bun test` run. That makes the suite ORDER-DEPENDENT: it can pass
// on one platform's file-glob order and cascade ("Export named X not found",
// or stale stubbed state) on another (e.g. Linux CI vs Windows local).
//
// Registering `afterAll(mock.restore())` here applies it to the root scope of
// EVERY test file. Bun runs each file's root `afterAll` when that file finishes,
// BEFORE the next file starts — so module mocks are torn down between files but
// NOT between tests within a file (within-file `beforeAll`-set mocks survive for
// all of that file's tests, which is what those files rely on). The result:
// each file starts from the real, unmocked module graph → fully order-independent.
// Secret defaults, part 2. Several src modules (e.g. src/auth/jwt.ts) hard-throw at
// MODULE LOAD when a secret is missing/short. A test file cannot reliably guard that
// itself: ESM hoists its static `import` of the app ABOVE any in-file `process.env`
// assignment, so the module graph loads first and the file dies before its first test.
// CI supplies these via the pipeline env, which is why the failure is invisible there
// and only bites a dev box with no hub/.env. Setting them in the preload (which Bun runs
// before ANY test module is imported) makes local == CI. Real env always wins.
process.env.JWT_SECRET ||= "test-secret-at-least-32-chars-long-aaaaaaaa";
process.env.SESSION_SECRET ||= "session-secret-at-least-32-chars-long-bb";

import { afterAll, mock } from "bun:test";

afterAll(() => {
  mock.restore();
});
