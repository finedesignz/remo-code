/**
 * Phase 07-D: Titanium license-changed webhook tests.
 *
 * DAL mocked via Bun's `mock.module()` so no Postgres is required. The route
 * module is dynamically imported AFTER the mock is installed, mirroring the
 * pattern used by `hub/test/coolify-webhook.test.ts`.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";

const SUBJECT = "subj-xyz";
const USER_ID = "user-77";
const SECRET = "this-is-a-test-secret-32-chars-ok";

// Track DAL calls.
const dalCalls = {
  getUserByTitaniumSubject: [] as string[],
  updateLicenseStatus: [] as Array<[string, string, string | null]>,
  recordAuthEvent: [] as any[],
};

// Per-test: which user the DAL returns from getUserByTitaniumSubject.
let userToReturn: { id: string } | null = { id: USER_ID };

const realDalWT = await import(`../src/db/dal.ts?real=${Date.now()}`);
mock.module("../src/db/dal.ts", () => ({
  ...realDalWT,
  getUserByTitaniumSubject: async (subject: string) => {
    dalCalls.getUserByTitaniumSubject.push(subject);
    return userToReturn;
  },
  updateLicenseStatus: async (uid: string, status: string, lid: string | null) => {
    dalCalls.updateLicenseStatus.push([uid, status, lid]);
  },
  recordAuthEvent: async (opts: any) => {
    dalCalls.recordAuthEvent.push(opts);
  },
}));

let app: Hono;
let mod: typeof import("../src/api/webhooks-titanium.ts");

beforeAll(async () => {
  mod = await import("../src/api/webhooks-titanium.ts");
  app = new Hono();
  app.route("/webhooks/titanium", mod.webhooksTitanium);
});

beforeEach(() => {
  dalCalls.getUserByTitaniumSubject = [];
  dalCalls.updateLicenseStatus = [];
  dalCalls.recordAuthEvent = [];
  userToReturn = { id: USER_ID };
});

function sign(ts: number, body: string, secret: string = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

function setSecret(value: string | undefined) {
  const cfg = require("../src/config").config;
  cfg.titaniumWebhookSecret = value ?? "";
}

describe("POST /webhooks/titanium/license-changed", () => {
  test("missing secret → 503 webhook_disabled", async () => {
    setSecret(undefined);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ subject: SUBJECT, license_status: "ACTIVE" });
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-signature": sign(ts, body, "anything"),
        "x-titanium-timestamp": String(ts),
      },
      body,
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("webhook_disabled");
  });

  test("missing signature header → 401", async () => {
    setSecret(SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-timestamp": String(ts),
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_signature");
  });

  test("bad signature → 401", async () => {
    setSecret(SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ subject: SUBJECT, license_status: "ACTIVE" });
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-signature": "sha256=" + "0".repeat(64),
        "x-titanium-timestamp": String(ts),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
  });

  test("stale timestamp (>5min) → 401", async () => {
    setSecret(SECRET);
    const ts = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const body = JSON.stringify({ subject: SUBJECT, license_status: "ACTIVE" });
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-signature": sign(ts, body),
        "x-titanium-timestamp": String(ts),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("stale_timestamp");
  });

  test("good signature + valid payload → 200 + updateLicenseStatus called", async () => {
    setSecret(SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      subject: SUBJECT,
      license_status: "EXPIRED",
      license_id: "lic-9",
    });
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-signature": sign(ts, body),
        "x-titanium-timestamp": String(ts),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(dalCalls.updateLicenseStatus.length).toBe(1);
    expect(dalCalls.updateLicenseStatus[0]).toEqual([USER_ID, "EXPIRED", "lic-9"]);
  });

  test("unknown subject → 200 noop, no updateLicenseStatus", async () => {
    setSecret(SECRET);
    userToReturn = null;
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ subject: SUBJECT, license_status: "ACTIVE" });
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-signature": sign(ts, body),
        "x-titanium-timestamp": String(ts),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).noop).toBe("unknown_subject");
    expect(dalCalls.updateLicenseStatus.length).toBe(0);
  });

  test("bad json body → 400", async () => {
    setSecret(SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const body = "not-json";
    const res = await app.request("/webhooks/titanium/license-changed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-titanium-signature": sign(ts, body),
        "x-titanium-timestamp": String(ts),
      },
      body,
    });
    expect(res.status).toBe(400);
  });
});
