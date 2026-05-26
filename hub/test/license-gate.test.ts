/**
 * Phase 07-D: License gating middleware tests.
 *
 * All cases run without Postgres/Redis — the gate's DAL + Titanium calls are
 * swapped via `__setDalForTesting`. Verifies the full decision matrix from
 * 07-CONTEXT.md plus cache TTL and 402 response shape.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  requireActiveLicense,
  __setDalForTesting,
  __resetDalForTesting,
} from "../src/license-gate";
import { config } from "../src/config";
import { BlockedSubjectError } from "../src/titanium-client";

type Fields = {
  license_status: string | null;
  license_id: string | null;
  license_checked_at: Date | null;
  titanium_subject: string | null;
};

const USER_ID = "user-123";
const SUBJECT = "subj-abc";

function makeApp(opts: { readOnlyOk?: boolean } = {}) {
  const app = new Hono();
  // Stub auth — sets userId so the gate can read it.
  app.use("*", async (c, next) => {
    c.set("userId", USER_ID);
    await next();
  });
  app.use("*", requireActiveLicense(opts));
  app.get("/", (c) => c.json({ ok: true }));
  app.post("/", (c) => c.json({ ok: true }));
  return app;
}

function freshFields(overrides: Partial<Fields> = {}): Fields {
  return {
    license_status: "ACTIVE",
    license_id: "lic-1",
    license_checked_at: new Date(),
    titanium_subject: SUBJECT,
    ...overrides,
  };
}

function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

let validateCalls = 0;
let updateCalls: Array<[string, string, string | null]> = [];
let recordCalls: any[] = [];

function installDal(fields: Fields, opts: {
  validateReturnsStatus?: string;
  validateReturnsLicenseId?: string;
  blocklist?: boolean;
} = {}) {
  __setDalForTesting({
    getUserLicenseFields: async () => fields,
    updateLicenseStatus: async (uid, status, lid) => {
      updateCalls.push([uid, status, lid]);
    },
    recordAuthEvent: async (opts: any) => {
      recordCalls.push(opts);
    },
    validateLicenseKey: async () => {
      validateCalls += 1;
      return {
        token: "tok",
        claims: {
          license: {
            status: opts.validateReturnsStatus ?? "ACTIVE",
            id: opts.validateReturnsLicenseId ?? fields.license_id ?? "lic-1",
          },
        },
      };
    },
    assertNotBlocked: async () => {
      if (opts.blocklist) throw new BlockedSubjectError(SUBJECT);
    },
  });
}

beforeEach(() => {
  __resetDalForTesting();
  validateCalls = 0;
  updateCalls = [];
  recordCalls = [];
});

describe("requireActiveLicense — decision matrix", () => {
  test("ACTIVE → 200", async () => {
    installDal(freshFields({ license_status: "ACTIVE" }));
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("EXPIRED < 7d + readOnlyOk + GET → 200 (grace)", async () => {
    // Use a fresh cache (recent checked_at) so refreshLicense doesn't run and
    // try to flip status. checked_at <3d ago is "in grace".
    installDal(
      freshFields({
        license_status: "EXPIRED",
        license_checked_at: new Date(Date.now() - 60 * 1000), // 1min ago — fresh
      }),
    );
    // Shift the perceived checked_at into grace by widening cache TTL so the
    // "old" checked_at counts as fresh AND is still <7d for grace check.
    const origTtl = config.titanium.licenseCacheTtlSeconds;
    (config.titanium as any).licenseCacheTtlSeconds = 60 * 60 * 24 * 30;
    __resetDalForTesting();
    installDal(
      freshFields({
        license_status: "EXPIRED",
        license_checked_at: daysAgo(3),
      }),
    );
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "GET" });
    (config.titanium as any).licenseCacheTtlSeconds = origTtl;
    expect(res.status).toBe(200);
  });

  test("EXPIRED < 7d + readOnlyOk + POST → 402 expired_grace", async () => {
    const origTtl = config.titanium.licenseCacheTtlSeconds;
    (config.titanium as any).licenseCacheTtlSeconds = 60 * 60 * 24 * 30;
    installDal(
      freshFields({
        license_status: "EXPIRED",
        license_checked_at: daysAgo(3),
      }),
    );
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "POST" });
    (config.titanium as any).licenseCacheTtlSeconds = origTtl;
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toEqual({ error: "license_required", reason: "expired_grace" });
  });

  test("EXPIRED ≥ 7d + GET → 402 expired (grace window over)", async () => {
    installDal(
      freshFields({
        license_status: "EXPIRED",
        license_checked_at: daysAgo(10),
      }),
    );
    // Cache is stale (>5 min). refreshLicense will run; mock returns EXPIRED
    // so the status stays EXPIRED but the fresh checked_at is "now" — which
    // would put it back in grace. To exercise "expired ≥ 7d" the refresh
    // must keep the old timestamp. We achieve that with a no-op refresh by
    // making the stored license_id null → updateLicenseStatus(NONE) path.
    // Simpler: install a fresh-cache row (checked_at recent) with EXPIRED +
    // make readOnlyOk false so GET also fails — that's a clean ≥7d-equivalent.
    __resetDalForTesting();
    installDal(
      freshFields({
        license_status: "EXPIRED",
        license_checked_at: new Date(), // fresh cache, no refresh
      }),
    );
    const app = makeApp({ readOnlyOk: true });
    // Force "not in grace" by using readOnlyOk + a checked_at that's ≥7d old
    // AND a fresh-cache claim. The gate's grace check uses license_checked_at
    // so we need a fresh-cache (skip refresh) AND an old checked_at.
    // Trick: set licenseCacheTtl to a huge value so the old date is "fresh".
    const origTtl = config.titanium.licenseCacheTtlSeconds;
    (config.titanium as any).licenseCacheTtlSeconds = 60 * 60 * 24 * 30; // 30d
    __resetDalForTesting();
    installDal(
      freshFields({
        license_status: "EXPIRED",
        license_checked_at: daysAgo(10),
      }),
    );
    const app2 = makeApp({ readOnlyOk: true });
    const res = await app2.request("/", { method: "GET" });
    (config.titanium as any).licenseCacheTtlSeconds = origTtl;
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.reason).toBe("expired");
  });

  test("BANNED → 402", async () => {
    installDal(freshFields({ license_status: "BANNED" }));
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "GET" });
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("banned");
  });

  test("NONE → 402", async () => {
    installDal(freshFields({ license_status: "NONE" }));
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("none");
  });

  test("blocklisted subject → 402 blocked", async () => {
    installDal(freshFields({ license_status: "ACTIVE" }), { blocklist: true });
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "GET" });
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("blocked");
  });

  test("missing userId → 401", async () => {
    installDal(freshFields());
    const app = new Hono();
    // No auth stub → userId unset.
    app.use("*", requireActiveLicense({ readOnlyOk: true }));
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });
});

describe("requireActiveLicense — cache TTL", () => {
  test("fresh cache → no validateLicenseKey call", async () => {
    installDal(freshFields({ license_status: "ACTIVE" }));
    const app = makeApp({ readOnlyOk: true });
    await app.request("/", { method: "POST" });
    await app.request("/", { method: "POST" });
    expect(validateCalls).toBe(0);
  });

  test("stale cache → validateLicenseKey called once", async () => {
    installDal(
      freshFields({
        license_status: "ACTIVE",
        license_checked_at: new Date(Date.now() - 10 * 60 * 1000), // 10min old
      }),
      { validateReturnsStatus: "ACTIVE" },
    );
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect(validateCalls).toBe(1);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][1]).toBe("ACTIVE");
  });

  test("stale cache + validate returns EXPIRED → 402", async () => {
    installDal(
      freshFields({
        license_status: "ACTIVE",
        license_checked_at: new Date(Date.now() - 10 * 60 * 1000),
      }),
      { validateReturnsStatus: "EXPIRED" },
    );
    const app = makeApp({ readOnlyOk: true });
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(402);
    expect(validateCalls).toBe(1);
  });
});

describe("requireActiveLicense — 402 response shape", () => {
  test("Content-Type is application/json", async () => {
    installDal(freshFields({ license_status: "BANNED" }));
    const app = makeApp();
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  test("body shape", async () => {
    installDal(freshFields({ license_status: "BANNED" }));
    const app = makeApp();
    const res = await app.request("/", { method: "POST" });
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["error", "reason"]);
    expect(body.error).toBe("license_required");
  });
});

describe("requireActiveLicense — audit log on denial", () => {
  test("denial writes license_check_failed", async () => {
    installDal(freshFields({ license_status: "NONE" }));
    const app = makeApp();
    await app.request("/", { method: "POST" });
    expect(recordCalls.length).toBeGreaterThan(0);
    expect(recordCalls[0].eventType).toBe("license_check_failed");
    expect(recordCalls[0].userId).toBe(USER_ID);
  });

  test("pass is silent (no audit write)", async () => {
    installDal(freshFields({ license_status: "ACTIVE" }));
    const app = makeApp();
    await app.request("/", { method: "POST" });
    expect(recordCalls.length).toBe(0);
  });
});
