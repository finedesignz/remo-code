/**
 * Phase 07-D: License gating middleware.
 *
 * Composes AFTER `authMiddleware` (which sets `userId` on the context).
 * Reads the cached `users.license_status` + `license_checked_at`. If the cache
 * is stale (older than `config.titanium.licenseCacheTtlSeconds`), re-queries
 * Titanium and persists the new state via `updateLicenseStatus`. Always
 * consults the real-time Redis blocklist via `assertNotBlocked`.
 *
 * Decision matrix (per 07-CONTEXT.md §"License gating — ON from D0"):
 *
 *   ACTIVE                          → pass
 *   EXPIRED < 7d AND method is GET  → pass (read-only grace)
 *   EXPIRED < 7d AND method ≠ GET   → 402 license_required (expired_grace)
 *   EXPIRED ≥ 7d                    → 402 license_required (expired)
 *   SUSPENDED / BANNED / NONE / …   → 402 license_required (<state>)
 *   Blocklisted (any state)         → 402 license_required (blocked)
 *
 * 402 responses write a throttled `auth_events.license_check_failed`. Passes
 * are silent on the hot path to keep the audit log scannable.
 *
 * Notes:
 *   - Gate sits AFTER auth, so if `userId` is missing the gate just returns
 *     401 — matching `authMiddleware`'s own response shape, no foot-gun.
 *   - License-key validation strategy: when the cache is stale and the user
 *     has a stored `license_id`, we call `validateLicenseKey(license_id)` to
 *     refresh status. Hot path stays local (cache hit) the rest of the time.
 *   - Test seam: `__setDalForTesting` lets the test suite swap DAL + Titanium
 *     calls without a Postgres/Redis connection.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { config } from "./config";
import {
  getUserLicenseFields,
  updateLicenseStatus,
  recordAuthEvent,
} from "./db/dal";
import {
  validateLicenseKey,
  assertNotBlocked,
  BlockedSubjectError,
  TitaniumApiError,
  TitaniumVerifyError,
} from "./titanium-client";

const GRACE_DAYS_DEFAULT = 7;
const LICENSE_CHECK_FAILED_THROTTLE_MS = 60_000;

// One-shot boot warning when LICENSE_REQUIRED=false. Logged on first request,
// not on every request, to keep prod logs scannable.
let permissiveWarned = false;

// Per-user throttle of `license_check_failed` audit writes — at most one
// every 60s to keep the log scannable during a burst of mutating requests.
const lastLogged = new Map<string, number>();

type LicenseFields = {
  license_status: string | null;
  license_id: string | null;
  license_checked_at: Date | null;
  titanium_subject: string | null;
};

type DalHooks = {
  getUserLicenseFields: (userId: string) => Promise<LicenseFields | null>;
  updateLicenseStatus: (
    userId: string,
    status: string,
    licenseId: string | null,
  ) => Promise<void>;
  recordAuthEvent: (opts: {
    userId?: string | null;
    eventType: string;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
  validateLicenseKey: (
    key: string,
  ) => Promise<{ token: string; claims: { license?: { status?: string; id?: string } } }>;
  assertNotBlocked: (subject: string) => Promise<void>;
};

let dal: DalHooks = {
  getUserLicenseFields,
  updateLicenseStatus,
  recordAuthEvent,
  validateLicenseKey: validateLicenseKey as any,
  assertNotBlocked,
};

export function __setDalForTesting(overrides: Partial<DalHooks>): void {
  dal = {
    getUserLicenseFields,
    updateLicenseStatus,
    recordAuthEvent,
    validateLicenseKey: validateLicenseKey as any,
    assertNotBlocked,
    ...overrides,
  };
}

export function __resetDalForTesting(): void {
  dal = {
    getUserLicenseFields,
    updateLicenseStatus,
    recordAuthEvent,
    validateLicenseKey: validateLicenseKey as any,
    assertNotBlocked,
  };
  lastLogged.clear();
}

export type LicenseGateOptions = {
  /** When true, GET requests are allowed during the EXPIRED < 7d grace window. */
  readOnlyOk?: boolean;
  /** Override grace window (default 7 days). */
  graceDays?: number;
};

function isCacheFresh(checkedAt: Date | null): boolean {
  if (!checkedAt) return false;
  const ageMs = Date.now() - checkedAt.getTime();
  return ageMs < config.titanium.licenseCacheTtlSeconds * 1000;
}

function isWithinGrace(checkedAt: Date | null, graceDays: number): boolean {
  if (!checkedAt) return false;
  const ageMs = Date.now() - checkedAt.getTime();
  return ageMs < graceDays * 24 * 60 * 60 * 1000;
}

async function refreshLicense(
  userId: string,
  fields: LicenseFields,
): Promise<{ status: string; license_id: string | null }> {
  // Without a stored license_id we cannot re-validate against Titanium; mark
  // as NONE and persist so the cache row is fresh.
  if (!fields.license_id) {
    await dal.updateLicenseStatus(userId, "NONE", null);
    return { status: "NONE", license_id: null };
  }
  try {
    const { claims } = await dal.validateLicenseKey(fields.license_id);
    const status = (claims.license?.status ?? "ACTIVE").toUpperCase();
    const licenseId = claims.license?.id ?? fields.license_id;
    await dal.updateLicenseStatus(userId, status, licenseId);
    return { status, license_id: licenseId };
  } catch (err: any) {
    // Titanium reachable but rejecting → expired/banned/whatever it told us.
    // Titanium unreachable (TitaniumApiError) → keep the cached value and let
    // the existing grace logic handle it. We DON'T flip ACTIVE → EXPIRED on
    // a transient network blip — that would break decoupled-for-read.
    if (err instanceof TitaniumApiError) {
      console.warn(
        `[license-gate] refresh failed; serving cached status=${fields.license_status ?? "NONE"}: ${err.message}`,
      );
      return {
        status: fields.license_status ?? "NONE",
        license_id: fields.license_id,
      };
    }
    if (err instanceof TitaniumVerifyError) {
      // Transient verify failures (JWKS endpoint down / network blip surfaced
      // as a verify error rather than TitaniumApiError) MUST NOT flip ACTIVE
      // → INVALID. Treat 'network', 'malformed' (covers jose's
      // JWKSInvalid / fetch errors), and unknown-kind verify errors as
      // transient: keep cached value, log, continue with grace logic.
      const transient =
        err.kind === "network" ||
        err.kind === "malformed" ||
        /jwks/i.test(err.message);
      if (transient) {
        console.warn(
          `[license-gate] transient verify error (${err.kind}: ${err.message}) — preserving cached status=${fields.license_status ?? "NONE"}`,
        );
        return {
          status: fields.license_status ?? "NONE",
          license_id: fields.license_id,
        };
      }
      // Map definitive verify errors to a sensible state and persist.
      const kindStatus =
        err.kind === "expired" ? "EXPIRED"
        : err.kind === "blocked" ? "BANNED"
        : "INVALID";
      await dal.updateLicenseStatus(userId, kindStatus, fields.license_id);
      return { status: kindStatus, license_id: fields.license_id };
    }
    // Unknown error — be conservative and treat as NONE.
    await dal.updateLicenseStatus(userId, "NONE", fields.license_id);
    return { status: "NONE", license_id: fields.license_id };
  }
}

async function logDenialThrottled(
  userId: string,
  reason: string,
  c: Context,
): Promise<void> {
  const now = Date.now();
  const last = lastLogged.get(userId) ?? 0;
  if (now - last < LICENSE_CHECK_FAILED_THROTTLE_MS) return;
  lastLogged.set(userId, now);
  try {
    await dal.recordAuthEvent({
      userId,
      eventType: "license_check_failed",
      ip:
        c.req.header("cf-connecting-ip") ||
        c.req.header("x-real-ip") ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        null,
      userAgent: c.req.header("user-agent") || null,
      metadata: { reason, path: c.req.path, method: c.req.method },
    });
  } catch {
    // Audit-log failure must not break the request flow.
  }
}

function deny(c: Context, reason: string) {
  return c.json({ error: "license_required", reason }, 402);
}

export function requireActiveLicense(
  opts: LicenseGateOptions = {},
): MiddlewareHandler {
  const graceDays = opts.graceDays ?? GRACE_DAYS_DEFAULT;
  const readOnlyOk = opts.readOnlyOk ?? false;

  return async (c: Context, next: Next) => {
    // Escape hatch: TITANIUM_BYPASS=true (Phase 07 bypass mode) OR
    // LICENSE_REQUIRED=false. Either disables the gate entirely.
    // Used while Keygen JWKS is unhealthy so REST identity routes don't 402.
    if (config.titaniumBypass || !config.licenseRequired) {
      if (!permissiveWarned) {
        permissiveWarned = true;
        const reason = config.titaniumBypass ? "TITANIUM_BYPASS=true" : "LICENSE_REQUIRED=false";
        console.warn(
          `[license-gate] ${reason} → permissive mode (all authed requests pass)`,
        );
      }
      return next();
    }

    const userId = c.get("userId") as string | undefined;
    if (!userId) {
      // Auth missing — defer to the upstream 401 shape.
      return c.json({ error: "Unauthorized" }, 401);
    }

    let fields = await dal.getUserLicenseFields(userId);
    if (!fields) {
      await logDenialThrottled(userId, "user_not_found", c);
      return deny(c, "user_not_found");
    }

    // Resolve effective status (cache vs. fresh fetch).
    let status = (fields.license_status ?? "NONE").toUpperCase();
    let licenseId = fields.license_id;

    if (!isCacheFresh(fields.license_checked_at)) {
      const refreshed = await refreshLicense(userId, fields);
      status = refreshed.status.toUpperCase();
      licenseId = refreshed.license_id;
      // Refresh the local view so the grace check below uses the new ts.
      fields = {
        ...fields,
        license_status: status,
        license_id: licenseId,
        license_checked_at: new Date(),
      };
    }

    // Real-time blocklist consult — never cached.
    if (fields.titanium_subject) {
      try {
        await dal.assertNotBlocked(fields.titanium_subject);
      } catch (err) {
        if (err instanceof BlockedSubjectError) {
          await logDenialThrottled(userId, "blocked", c);
          return deny(c, "blocked");
        }
        // Redis down / misconfigured: fail open ONLY if status is ACTIVE,
        // closed otherwise. This matches the decoupled-for-read principle —
        // a healthy ACTIVE user should not be locked out by a Redis blip.
        if (status !== "ACTIVE") {
          await logDenialThrottled(userId, "blocklist_check_failed", c);
          return deny(c, "blocklist_check_failed");
        }
      }
    }

    // Decision matrix.
    if (status === "ACTIVE") {
      return next();
    }

    if (status === "EXPIRED") {
      const inGrace = isWithinGrace(fields.license_checked_at, graceDays);
      const isRead = c.req.method === "GET";
      if (readOnlyOk && isRead && inGrace) {
        return next();
      }
      const reason = inGrace ? "expired_grace" : "expired";
      await logDenialThrottled(userId, reason, c);
      return deny(c, reason);
    }

    const reason = status.toLowerCase() || "none";
    await logDenialThrottled(userId, reason, c);
    return deny(c, reason);
  };
}
