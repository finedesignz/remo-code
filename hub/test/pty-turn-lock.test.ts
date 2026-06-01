/**
 * Phase 20 plan 04 — PTY write-arbitration turn lock (R-TG-10,
 * T-20-10/11/12).
 *
 * Asserts: a second writer is QUEUED (not interleaved); the lock releases on an
 * observed turn_complete and promotes the next writer; a permission RESPONSE
 * bypasses the lock; queue overflow drops the oldest; the safety TTL releases.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  acquire,
  release,
  onTurnComplete,
  holder,
  queueDepth,
  allowResponseBypass,
  _resetTurnLockForTests,
  _configureTurnLockForTests,
} from "../src/telegram/turn-lock.ts";

beforeEach(() => _resetTurnLockForTests());

describe("single-writer turn lock", () => {
  it("first writer acquires immediately; second is queued, not interleaved", async () => {
    expect(await acquire("s1", "client:A")).toBe(true);
    expect(holder("s1")).toBe("client:A");

    let bGranted = false;
    const bPromise = acquire("s1", "telegram").then((g) => (bGranted = g));
    await new Promise((r) => setTimeout(r, 5));
    // B has NOT been granted — it is queued behind A.
    expect(bGranted).toBe(false);
    expect(queueDepth("s1")).toBe(1);

    // A's turn completes → B is promoted.
    onTurnComplete("s1");
    await bPromise;
    expect(bGranted).toBe(true);
    expect(holder("s1")).toBe("telegram");
  });

  it("same holder re-acquire is idempotent (streaming keystrokes within a turn)", async () => {
    expect(await acquire("s2", "client:A")).toBe(true);
    expect(await acquire("s2", "client:A")).toBe(true);
    expect(queueDepth("s2")).toBe(0);
  });

  it("release with an empty queue frees the lock", async () => {
    await acquire("s3", "client:A");
    release("s3");
    expect(holder("s3")).toBeNull();
  });

  it("turn_complete releases + promotes the next queued writer (FIFO)", async () => {
    await acquire("s4", "W1");
    const p2 = acquire("s4", "W2");
    const p3 = acquire("s4", "W3");
    onTurnComplete("s4"); // W1 done → W2 holds
    expect(await p2).toBe(true);
    expect(holder("s4")).toBe("W2");
    onTurnComplete("s4"); // W2 done → W3 holds
    expect(await p3).toBe(true);
    expect(holder("s4")).toBe("W3");
  });

  it("queue overflow drops the OLDEST waiter with a notice (bounded)", async () => {
    _configureTurnLockForTests({ queueBound: 2 });
    await acquire("s5", "H");
    const dropped = acquire("s5", "old"); // will be dropped when 3rd arrives
    acquire("s5", "mid");
    acquire("s5", "new"); // pushes past bound → oldest ('old') dropped
    expect(await dropped).toBe(false);
    expect(queueDepth("s5")).toBe(2);
  });

  it("safety TTL force-releases a wedged holder", async () => {
    _configureTurnLockForTests({ ttlMs: 30 });
    await acquire("s6", "H");
    expect(holder("s6")).toBe("H");
    await new Promise((r) => setTimeout(r, 60));
    expect(holder("s6")).toBeNull();
  });
});

describe("permission response exemption (T-20-12)", () => {
  it("a response bypasses acquire — never queues, never deadlocks", async () => {
    await acquire("s7", "client:A"); // A holds the turn
    // A permission response from the non-holder (telegram) is allowed without
    // acquiring the lock — answering the in-flight prompt completes A's turn.
    expect(allowResponseBypass("s7")).toBe(true);
    // The lock is still held by A (the response didn't steal the turn).
    expect(holder("s7")).toBe("client:A");
  });
});
