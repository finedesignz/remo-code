/**
 * Phase 07-E: tests for hub/scripts/migrate-users-to-titanium.ts
 *
 * Pure unit tests using the script's injectable seam (MigrationDeps). No DB,
 * no Keygen network, no email send. The script reuses the magic-link signer
 * exported from hub/src/api/auth.ts (__testing.signMagicLink), which itself is
 * tested in magic-link.test.ts — here we inject a fake signer to keep tests
 * standalone.
 *
 * Covers:
 *   - parseArgs: defaults, flags, validation
 *   - empty user set
 *   - all-new (linked_created branch)
 *   - all-existing-verified (linked_pending_verify branch)
 *   - all-existing-unverified (email_unverified skip)
 *   - all-existing-emailVerified-unknown (treated as pending_verify)
 *   - mix
 *   - dry-run safety (no DB writes, no Keygen creates, no emails)
 *   - --email single-user mode
 *   - --resend re-mails pending_verify only
 *   - error mid-run: continues + reports + exit-code intent (errors > 0)
 *   - already-linked rows skipped on re-run (idempotency)
 *   - email send failure surfaces as error
 *   - batch pacing: batchDelayMs honored between batches but not after the last
 */

import { describe, test, expect } from "bun:test";
import {
  parseArgs,
  runMigration,
  type MigrationDeps,
  type MigrationOptions,
  type UserRow,
} from "../scripts/migrate-users-to-titanium.ts";

const TEST_TAG = `migrate07-${Date.now()}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkUser(suffix: string, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: `user-${TEST_TAG}-${suffix}`,
    email: `${TEST_TAG}-${suffix}@example.test`,
    titanium_subject: null,
    titanium_link_status: null,
    ...overrides,
  };
}

interface Recorder {
  keygenLookups: string[];
  keygenCreates: Array<{ email: string; metadata?: Record<string, unknown> }>;
  links: Array<{ userId: string; subject: string; email: string }>;
  pending: Array<{ userId: string; subject: string; email: string }>;
  emails: Array<{ to: string; subject: string }>;
}

function mkDeps(
  users: UserRow[],
  keygenState: Map<string, { id: string; emailVerified?: boolean | null }>,
  overrides: Partial<MigrationDeps> = {},
): { deps: MigrationDeps; rec: Recorder } {
  const rec: Recorder = {
    keygenLookups: [],
    keygenCreates: [],
    links: [],
    pending: [],
    emails: [],
  };
  const deps: MigrationDeps = {
    loadUsers: async ({ email, resend, limit }) => {
      let rows = users.slice();
      if (email) rows = rows.filter((u) => u.email === email.toLowerCase().trim());
      else if (resend) rows = rows.filter((u) => u.titanium_link_status === "pending_verify");
      else rows = rows.filter((u) => u.titanium_subject === null);
      if (limit !== null && limit !== undefined) rows = rows.slice(0, limit);
      return rows;
    },
    keygenAdmin: {
      async findUserByEmail(email) {
        rec.keygenLookups.push(email);
        const hit = keygenState.get(email);
        return hit ? { id: hit.id, email, emailVerified: hit.emailVerified ?? null } : null;
      },
      async createUser(input) {
        rec.keygenCreates.push(input);
        const created = { id: `keygen-${TEST_TAG}-${rec.keygenCreates.length}`, email: input.email };
        keygenState.set(input.email, { id: created.id, emailVerified: true });
        return created;
      },
    },
    linkTitaniumSubject: async (userId, subject, email) => {
      rec.links.push({ userId, subject, email });
    },
    setPendingVerify: async (userId, subject, email) => {
      rec.pending.push({ userId, subject, email });
    },
    sendEmail: async (input) => {
      rec.emails.push({ to: input.to, subject: input.subject });
      return true;
    },
    signMagicLink: async (payload) => ({
      token: `magic-${payload.sub}`,
      jti: `jti-${payload.sub}`,
      exp: Math.floor(Date.now() / 1000) + 900,
    }),
    publicBase: () => "https://test.local",
    now: () => new Date("2026-05-25T12:00:00.000Z"),
    ...overrides,
  };
  return { deps, rec };
}

function mkOpts(overrides: Partial<MigrationOptions> = {}): MigrationOptions {
  return {
    apply: true,
    batchSize: 50,
    batchDelayMs: 0,
    limit: null,
    email: null,
    resend: false,
    outputPath: "/dev/null/test.json", // never written — test calls runMigration directly
    ...overrides,
  };
}

// ── parseArgs ───────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("dry-run is the default", () => {
    const opts = parseArgs([]);
    expect(opts.apply).toBe(false);
    expect(opts.batchSize).toBe(50);
    expect(opts.batchDelayMs).toBe(5000);
    expect(opts.limit).toBeNull();
    expect(opts.email).toBeNull();
    expect(opts.resend).toBe(false);
  });

  test("--apply opts into mutation; --dry-run forces off", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  test("space-separated and equals-form flags both parse", () => {
    const a = parseArgs(["--batch-size", "25", "--limit", "10", "--email", "a@b.test"]);
    expect(a.batchSize).toBe(25);
    expect(a.limit).toBe(10);
    expect(a.email).toBe("a@b.test");
    const b = parseArgs(["--batch-size=12", "--limit=3", "--email=c@d.test", "--batch-delay-ms=1000"]);
    expect(b.batchSize).toBe(12);
    expect(b.limit).toBe(3);
    expect(b.email).toBe("c@d.test");
    expect(b.batchDelayMs).toBe(1000);
  });

  test("--resend flag", () => {
    expect(parseArgs(["--resend"]).resend).toBe(true);
  });
});

// ── runMigration: happy paths ───────────────────────────────────────────────

describe("runMigration — apply mode branches", () => {
  test("empty user set: zero counts, finished_at set", async () => {
    const { deps, rec } = mkDeps([], new Map());
    const log = await runMigration(mkOpts(), deps);
    expect(log.total_users).toBe(0);
    expect(log.linked_created).toBe(0);
    expect(log.linked_pending_verify).toBe(0);
    expect(log.errors).toEqual([]);
    expect(log.details).toEqual([]);
    expect(rec.keygenLookups).toEqual([]);
    expect(log.finished_at).toBeTruthy();
  });

  test("all-new: creates Keygen users, links subjects, sends welcome emails", async () => {
    const users = [mkUser("new-a"), mkUser("new-b"), mkUser("new-c")];
    const { deps, rec } = mkDeps(users, new Map());
    const log = await runMigration(mkOpts(), deps);
    expect(log.linked_created).toBe(3);
    expect(log.linked_pending_verify).toBe(0);
    expect(log.email_unverified).toBe(0);
    expect(log.errors).toEqual([]);
    expect(rec.keygenCreates).toHaveLength(3);
    expect(rec.links).toHaveLength(3);
    expect(rec.pending).toHaveLength(0);
    expect(rec.emails).toHaveLength(3);
    for (const e of rec.emails) {
      expect(e.subject).toContain("Welcome");
    }
    // Metadata includes remo_code_user_id + app_slug per Plan E spec.
    for (let i = 0; i < users.length; i++) {
      expect(rec.keygenCreates[i].metadata).toMatchObject({
        remo_code_user_id: users[i].id,
        app_slug: "remo-code",
      });
    }
  });

  test("all-existing-verified: pending_verify path, no Keygen creates, verify emails", async () => {
    const users = [mkUser("exist-a"), mkUser("exist-b")];
    const keygen = new Map([
      [users[0].email, { id: "keygen-exist-a", emailVerified: true as boolean | null }],
      [users[1].email, { id: "keygen-exist-b", emailVerified: true as boolean | null }],
    ]);
    const { deps, rec } = mkDeps(users, keygen);
    const log = await runMigration(mkOpts(), deps);
    expect(log.linked_created).toBe(0);
    expect(log.linked_pending_verify).toBe(2);
    expect(rec.keygenCreates).toHaveLength(0);
    expect(rec.links).toHaveLength(0);
    expect(rec.pending).toHaveLength(2);
    expect(rec.pending[0]).toEqual({ userId: users[0].id, subject: "keygen-exist-a", email: users[0].email });
    expect(rec.emails.every((e) => e.subject.toLowerCase().includes("verify"))).toBe(true);
  });

  test("existing-unverified: skipped, no DB writes, no emails", async () => {
    const u = mkUser("unverified");
    const keygen = new Map([[u.email, { id: "keygen-unv", emailVerified: false as boolean | null }]]);
    const { deps, rec } = mkDeps([u], keygen);
    const log = await runMigration(mkOpts(), deps);
    expect(log.email_unverified).toBe(1);
    expect(log.linked_created).toBe(0);
    expect(log.linked_pending_verify).toBe(0);
    expect(rec.links).toHaveLength(0);
    expect(rec.pending).toHaveLength(0);
    expect(rec.emails).toHaveLength(0);
    expect(log.details[0].keygen_user_id).toBe("keygen-unv");
  });

  test("existing with emailVerified=null is treated as pending_verify (magic-link is the verification)", async () => {
    const u = mkUser("unknown");
    const keygen = new Map([[u.email, { id: "keygen-unk", emailVerified: null }]]);
    const { deps, rec } = mkDeps([u], keygen);
    const log = await runMigration(mkOpts(), deps);
    expect(log.linked_pending_verify).toBe(1);
    expect(log.email_unverified).toBe(0);
    expect(rec.pending).toHaveLength(1);
  });

  test("mix of new + existing-verified + unverified + already-linked: each goes to the right bucket", async () => {
    const newUser = mkUser("mix-new");
    const existingUser = mkUser("mix-exist");
    const unverifiedUser = mkUser("mix-unv");
    const alreadyLinked = mkUser("mix-done", {
      titanium_subject: "keygen-done",
      titanium_link_status: "linked",
    });
    const keygen = new Map<string, { id: string; emailVerified?: boolean | null }>([
      [existingUser.email, { id: "keygen-mix-exist", emailVerified: true }],
      [unverifiedUser.email, { id: "keygen-mix-unv", emailVerified: false }],
    ]);
    // loadUsers default filter already drops already-linked; verify by passing the
    // full list and letting the mock filter mirror production behaviour.
    const { deps, rec } = mkDeps(
      [newUser, existingUser, unverifiedUser, alreadyLinked],
      keygen,
    );
    const log = await runMigration(mkOpts(), deps);
    expect(log.total_users).toBe(3); // alreadyLinked filtered out by loadUsers
    expect(log.linked_created).toBe(1);
    expect(log.linked_pending_verify).toBe(1);
    expect(log.email_unverified).toBe(1);
    expect(rec.emails).toHaveLength(2); // welcome + verify; unverified gets no email
  });
});

// ── runMigration: dry-run ───────────────────────────────────────────────────

describe("runMigration — dry-run safety", () => {
  test("dry-run makes no DB writes and sends no emails, but still classifies correctly", async () => {
    const newUser = mkUser("dry-new");
    const existingUser = mkUser("dry-exist");
    const keygen = new Map([
      [existingUser.email, { id: "keygen-dry-exist", emailVerified: true as boolean | null }],
    ]);
    const { deps, rec } = mkDeps([newUser, existingUser], keygen);
    const log = await runMigration(mkOpts({ apply: false }), deps);
    expect(log.mode).toBe("dry-run");
    expect(log.linked_created).toBe(1);
    expect(log.linked_pending_verify).toBe(1);
    expect(rec.keygenCreates).toHaveLength(0);
    expect(rec.links).toHaveLength(0);
    expect(rec.pending).toHaveLength(0);
    expect(rec.emails).toHaveLength(0);
    // Keygen lookups DO happen in dry-run — that's read-only and needed to
    // produce an accurate report.
    expect(rec.keygenLookups).toHaveLength(2);
  });
});

// ── runMigration: --email single-user ──────────────────────────────────────

describe("runMigration — --email single-user mode", () => {
  test("processes only the matching user, ignores the rest", async () => {
    const a = mkUser("solo-a");
    const b = mkUser("solo-b");
    const c = mkUser("solo-c");
    const { deps, rec } = mkDeps([a, b, c], new Map());
    const log = await runMigration(mkOpts({ email: b.email }), deps);
    expect(log.total_users).toBe(1);
    expect(log.linked_created).toBe(1);
    expect(rec.keygenCreates[0].email).toBe(b.email);
  });
});

// ── runMigration: --resend ─────────────────────────────────────────────────

describe("runMigration — --resend", () => {
  test("re-mails only pending_verify rows and skips already-linked ones", async () => {
    // pending row has titanium_subject still NULL but link_status='pending_verify'.
    const pending = mkUser("resend-pending", {
      titanium_subject: null,
      titanium_link_status: "pending_verify",
    });
    const linked = mkUser("resend-linked", {
      titanium_subject: "keygen-linked",
      titanium_link_status: "linked",
    });
    const { deps, rec } = mkDeps([pending, linked], new Map());
    const log = await runMigration(mkOpts({ resend: true }), deps);
    expect(log.total_users).toBe(1); // loadUsers filters to pending_verify only
    expect(log.resent_pending_verify).toBe(1);
    expect(rec.emails).toHaveLength(1);
    expect(rec.emails[0].subject.toLowerCase()).toContain("verify");
    expect(rec.keygenLookups).toHaveLength(0); // resend skips lookup
    expect(rec.pending).toHaveLength(0); // resend skips DB write
  });
});

// ── runMigration: idempotency ──────────────────────────────────────────────

describe("runMigration — idempotency", () => {
  test("already-linked rows passing through processUser are skipped (defence-in-depth)", async () => {
    // Force loadUsers to return an already-linked row even though the production
    // SQL would filter it. processUser MUST still skip it (per the in-function
    // guard).
    const alreadyLinked = mkUser("idem", {
      titanium_subject: "keygen-existing",
      titanium_link_status: "linked",
    });
    const { deps, rec } = mkDeps([], new Map(), {
      loadUsers: async () => [alreadyLinked],
    });
    const log = await runMigration(mkOpts(), deps);
    expect(log.total_users).toBe(1);
    expect(log.skipped_already_linked).toBe(1);
    expect(log.linked_created).toBe(0);
    expect(rec.keygenLookups).toHaveLength(0);
    expect(rec.links).toHaveLength(0);
    expect(rec.emails).toHaveLength(0);
  });
});

// ── runMigration: errors ───────────────────────────────────────────────────

describe("runMigration — error handling", () => {
  test("error mid-run is captured, run continues, exit-code intent (errors > 0)", async () => {
    const ok = mkUser("err-ok");
    const bad = mkUser("err-bad");
    const ok2 = mkUser("err-ok2");
    const keygen = new Map<string, { id: string; emailVerified?: boolean | null }>();
    const { deps, rec } = mkDeps([ok, bad, ok2], keygen, {
      keygenAdmin: {
        async findUserByEmail(email) {
          rec?.keygenLookups.push(email);
          return null;
        },
        async createUser(input) {
          if (input.email === bad.email) throw new Error("simulated Keygen 502");
          rec?.keygenCreates.push(input);
          return { id: `keygen-${input.email}`, email: input.email };
        },
      },
    });
    const log = await runMigration(mkOpts(), deps);
    expect(log.linked_created).toBe(2);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0].email).toBe(bad.email);
    expect(log.errors[0].error).toMatch(/502/);
    // The error row also lands in details.
    expect(log.details.some((d) => d.action === "error" && d.email === bad.email)).toBe(true);
  });

  test("email send failure (sendEmail returns false) surfaces as error", async () => {
    const u = mkUser("mail-fail");
    const { deps } = mkDeps([u], new Map(), {
      sendEmail: async () => false,
    });
    const log = await runMigration(mkOpts(), deps);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0].error).toMatch(/emails4agents/i);
  });
});

// ── runMigration: batch pacing ─────────────────────────────────────────────

describe("runMigration — batch pacing", () => {
  test("waits between batches but NOT after the last batch", async () => {
    const users = [mkUser("p1"), mkUser("p2"), mkUser("p3"), mkUser("p4"), mkUser("p5")];
    const { deps } = mkDeps(users, new Map());
    const opts = mkOpts({ batchSize: 2, batchDelayMs: 50 }); // batches: 2+2+1, 2 delays
    const started = Date.now();
    const log = await runMigration(opts, deps);
    const elapsed = Date.now() - started;
    expect(log.linked_created).toBe(5);
    // Two inter-batch delays of 50ms each → at least ~100ms. Give generous slack.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    // Sanity: it shouldn't take MUCH longer than 2 delays + overhead.
    expect(elapsed).toBeLessThan(500);
  });
});

// ── Sanity ─────────────────────────────────────────────────────────────────

describe("module surface", () => {
  test("exports runMigration + parseArgs", () => {
    expect(typeof runMigration).toBe("function");
    expect(typeof parseArgs).toBe("function");
  });
});
