/**
 * Regression — release the PTY write-lock when a writer (a /ws/client connection)
 * goes away, so a dead/closed connection can never wedge another connection's
 * term.input ("terminal renders but I can't type"). Also: idempotent holder
 * re-acquire RE-ARMS the interactive TTL so active typing never trips the backstop
 * while an abandoned holder still self-heals.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  acquire,
  releaseByWriter,
  holder,
  queueDepth,
  _resetTurnLockForTests,
  _configureTurnLockForTests,
} from "../src/telegram/turn-lock.ts";

beforeEach(() => _resetTurnLockForTests());

describe("releaseByWriter (disconnect-driven release)", () => {
  it("releases a held lock and promotes the next queued waiter", async () => {
    await acquire("s1", "client:A"); // A holds
    let bGranted = false;
    const bPromise = acquire("s1", "client:B").then((g) => (bGranted = g));
    await new Promise((r) => setTimeout(r, 5));
    expect(bGranted).toBe(false);
    expect(holder("s1")).toBe("client:A");

    // A's connection closes → its lock is released, B is promoted.
    releaseByWriter("client:A");
    await bPromise;
    expect(bGranted).toBe(true);
    expect(holder("s1")).toBe("client:B");
  });

  it("drops the departing writer's queued waiters (their promises resolve false)", async () => {
    await acquire("s2", "client:H"); // H holds
    const qa = acquire("s2", "client:Q"); // Q queued
    const qb = acquire("s2", "client:Q"); // Q keystroke #2 — COALESCES onto the same waiter
    await new Promise((r) => setTimeout(r, 5));
    // fix/dup-pty-writer: one writer = at most ONE waiter. Pre-fix this was 2, and a
    // blocked xterm queued one waiter PER KEYSTROKE until the bound overflowed.
    expect(queueDepth("s2")).toBe(1);

    // Q's connection closes while queued → both its waiters resolve false; H keeps lock.
    releaseByWriter("client:Q");
    expect(await qa).toBe(false);
    expect(await qb).toBe(false);
    expect(queueDepth("s2")).toBe(0);
    expect(holder("s2")).toBe("client:H");
  });

  it("a disconnect-driven release unblocks a second writer's pending acquire", async () => {
    await acquire("s3", "client:dead"); // a connection that will close
    let typed = false;
    const desktop = acquire("s3", "client:desktop").then((g) => (typed = g));
    await new Promise((r) => setTimeout(r, 5));
    expect(typed).toBe(false); // desktop keystroke is queued behind the dead writer

    releaseByWriter("client:dead"); // dead connection closes
    expect(await desktop).toBe(true); // desktop can now type
    expect(typed).toBe(true);
    expect(holder("s3")).toBe("client:desktop");
  });

  it("is idempotent + safe when the writer holds/queues nothing", () => {
    expect(() => releaseByWriter("client:nobody")).not.toThrow();
    acquire("s4", "client:other");
    expect(() => releaseByWriter("client:nobody")).not.toThrow();
    expect(holder("s4")).toBe("client:other");
  });
});

describe("idempotent re-acquire re-arms the interactive TTL", () => {
  it("active re-acquire keeps the lock past the original TTL; idle holder frees", async () => {
    _configureTurnLockForTests({ ttlMs: 40 });
    await acquire("s5", "client:typing");
    // Keep re-acquiring (streaming keystrokes) — each re-acquire re-arms the TTL,
    // so the holder survives well past a single TTL window of inactivity.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 25));
      expect(await acquire("s5", "client:typing")).toBe(true);
      expect(holder("s5")).toBe("client:typing"); // never force-released mid-typing
    }
    // Now go idle — no more re-acquire. The backstop fires after ttlMs.
    await new Promise((r) => setTimeout(r, 80));
    expect(holder("s5")).toBeNull();
  });
});
