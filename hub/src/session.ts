// Phase 07-C: opaque server-side dashboard sessions on top of Plan B's
// `auth_sessions` table.
//
// Cookie shape: `__Host-remo_sid` — HttpOnly, Secure, SameSite=Lax, Path=/,
// NO Domain. The `__Host-` prefix mandates exactly those flags; setting Domain
// would silently break the cookie (browsers reject it).
//
// Idle timeout: 60 minutes. Absolute timeout: 7 days (enforced via DAL
// expires_at). Both checked on every `verifyAuthSessionCookie` call. We
// touch (last_used_at) on successful verify so the idle window slides.
//
// Cookie value MUST be `createAuthSession().token` (raw). `.id` is the sha-256
// hash used as the DB primary key — server-only, never on the wire.

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  type AuthSessionRow,
  createAuthSession as dalCreate,
  getAuthSessionByToken,
  touchAuthSession,
  deleteAuthSession as dalDelete,
  getUserById,
} from './db/dal';
import { config } from './config';

export const SESSION_COOKIE_NAME = '__Host-remo_sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days absolute
export const SESSION_IDLE_MS = 60 * 60 * 1000; // 60 minutes

// Module-load guard. SESSION_SECRET is required once session paths are live;
// reused by csrf.ts for HMAC. Optional during Plan A pre-cutover boot stays
// honored — only fail when the secret is *set but too short*.
if (config.sessionSecret && config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters');
}

export interface AuthSessionContext {
  userId: string;
  sessionRow: AuthSessionRow;
  user: { id: string; email: string; role: string; display_name?: string | null };
}

// Phase 12.1: detect Tauri WebView origins on the request so we can emit a
// cross-origin-safe cookie variant (`SameSite=None; Secure; Partitioned`).
// Browser requests (no Tauri origin) keep the strict `__Host-` + `SameSite=Lax`
// default. Centralized so the auth callback, finalize-mobile, and re-login
// flows make the same decision.
export function isTauriOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (!config.mobileTauriOriginsEnabled) return false;
  return config.mobileTauriOrigins.includes(origin);
}

export function originFromContext(c: Context): string | null {
  return c.req.header('origin') ?? null;
}

export interface CookieAttrs {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'None' | 'Strict';
  path: string;
  maxAge: number;
  partitioned?: boolean;
}

export function sessionCookieAttrsForOrigin(origin: string | null | undefined): CookieAttrs {
  if (isTauriOrigin(origin)) {
    // The `__Host-` prefix mandates SameSite=Lax/Strict — incompatible with
    // SameSite=None. So the Tauri variant uses an unprefixed cookie name.
    return {
      name: 'remo_sid',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
      partitioned: true,
    };
  }
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function createAndSetSession(
  c: Context,
  opts: { userId: string; ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const result = await dalCreate({
    userId: opts.userId,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  setSessionCookie(c, result.token);
  return result;
}

export function setSessionCookie(c: Context, token: string): void {
  const attrs = sessionCookieAttrsForOrigin(originFromContext(c));
  // hono/cookie's setCookie does not currently accept `partitioned`. Emit the
  // Set-Cookie header by hand when we need that attribute so the Tauri WebView
  // honors the CHIPS partitioned cookie semantics.
  if (attrs.partitioned || attrs.sameSite === 'None') {
    const parts = [
      `${attrs.name}=${encodeURIComponent(token)}`,
      `Path=${attrs.path}`,
      `Max-Age=${attrs.maxAge}`,
      `HttpOnly`,
      `Secure`,
      `SameSite=${attrs.sameSite}`,
    ];
    if (attrs.partitioned) parts.push('Partitioned');
    c.header('Set-Cookie', parts.join('; '), { append: true });
    return;
  }
  setCookie(c, attrs.name, token, {
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: attrs.maxAge,
  });
}

export function clearSessionCookie(c: Context): void {
  // deleteCookie with the same flags so browsers actually drop it.
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
    secure: true,
  });
  // Phase 12.1: also clear the Tauri-origin unprefixed cookie if present.
  deleteCookie(c, MOBILE_SESSION_COOKIE_NAME, {
    path: '/',
    secure: true,
  });
}

export const MOBILE_SESSION_COOKIE_NAME = 'remo_sid';

export function readSessionCookie(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE_NAME) ?? getCookie(c, MOBILE_SESSION_COOKIE_NAME) ?? null;
}

// Extract `__Host-remo_sid` from a raw Cookie header (used in WS upgrade where
// we don't have a Hono Context). Returns null if absent.
export function parseSessionCookieFromHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  let mobileToken: string | null = null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1));
    }
    if (name === MOBILE_SESSION_COOKIE_NAME && mobileToken === null) {
      mobileToken = decodeURIComponent(part.slice(eq + 1));
    }
  }
  return mobileToken;
}

// Look up + validate a session by raw token. Enforces idle (60m) and absolute
// (DAL expires_at). On success, touches last_used_at and returns the context.
// On any failure, removes the row (if present) and returns null.
export async function verifyAuthSessionToken(token: string): Promise<AuthSessionContext | null> {
  if (!token) return null;
  const row = await getAuthSessionByToken(token);
  if (!row) return null;

  const now = Date.now();
  const idleAge = now - new Date(row.last_used_at).getTime();
  if (idleAge > SESSION_IDLE_MS) {
    await dalDelete(token);
    return null;
  }

  const user = await getUserById(row.user_id);
  if (!user) {
    await dalDelete(token);
    return null;
  }

  await touchAuthSession(token);
  return {
    userId: row.user_id,
    sessionRow: row,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      display_name: user.display_name ?? null,
    },
  };
}

export async function verifyAuthSessionCookie(c: Context): Promise<AuthSessionContext | null> {
  const token = readSessionCookie(c);
  if (!token) return null;
  return verifyAuthSessionToken(token);
}

export async function destroySession(c: Context): Promise<void> {
  const token = readSessionCookie(c);
  if (token) {
    try { await dalDelete(token); } catch {}
  }
  clearSessionCookie(c);
}
