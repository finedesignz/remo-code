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
import { afterAll, mock } from "bun:test";

afterAll(() => {
  mock.restore();
});
