// Titanium hosted login (consumer side). Server-only helpers used by
// hub/src/api/titanium-auth.ts.
//
// Canonical contract: titanium-licensing docs/consumer-integration/README.md
// §3.3 (exchange, appSlug fail-closed, accountId), §3.3.1 (bind the login to the
// browser that started it: state cookie, PKCE, confirmation page) and §3.3.2
// (logout through the portal); tauri.md for the app deep-link leg (PKCE +
// app_slug mandatory).
//
// Flow (web):
//   start   : POST /auth/email (the SPA email form) or POST /auth/start (the
//             "Continue with Titanium" button) sets the 15-minute `remo_login`
//             cookie {state[, verifier]} and either asks the portal to email a link
//             (server-side) or 303s to the hosted login with PKCE.
//   callback: GET /auth/callback?state&act — state matches the cookie: exchange
//             (+ code_verifier) and mint; no match: exchange, park the result in the
//             5-minute `remo_confirm` cookie and ask "Sign in as a***@x?".
//   confirm : POST /auth/confirm — same Origin + valid cookie + csrf → mint.
// Flow (app shell, remo-code:// deep link): POST /auth/email {client:"app"} sets the
//   pending cookie with PKCE and a remo-code://auth/callback return_url; the shell
//   POSTs {state, act} to /auth/app-finalize from the WebView (same cookie jar).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { signPurposeToken, verifyPurposeToken } from "./purpose-tokens.ts";

/** The Titanium app slug this hub signs in as (registered in the Titanium registry). */
export const TITANIUM_APP_SLUG = "remo-code";

/** Portal host for the server-to-server calls (send-magic-link, exchange). */
export const TITANIUM_PORTAL_BASE = "https://license.titaniumlabs.us";

/** Canonical browser-facing login host (hosted login page + logout). */
export const TITANIUM_AUTH_BASE = "https://auth.titaniumlabs.us";

/** Portal logout: a top-level form POST only (its cookies are host-only SameSite=Lax). */
export const TITANIUM_LOGOUT_URL = `${TITANIUM_AUTH_BASE}/api/auth/logout`;

/** Deep-link return for the Tauri shell. Must be listed as `remo-code://auth` in the
 *  portal's ALLOWED_RETURN_URL_ORIGINS. */
export const APP_DEEP_LINK_CALLBACK = "remo-code://auth/callback";

const PORTAL_TIMEOUT_MS = 10_000;

export const PENDING_LOGIN_COOKIE = "remo_login";
export const PENDING_LOGIN_TTL_SECONDS = 15 * 60;
export const PENDING_CONFIRM_COOKIE = "remo_confirm";
export const PENDING_CONFIRM_TTL_SECONDS = 5 * 60;
/** Both pending cookies are only read under /auth (callback, confirm, app-finalize). */
export const PENDING_COOKIE_PATH = "/auth";

export type LoginClient = "web" | "app";

/** The hub's public origin (REMO_PUBLIC_URL), never the request Host. */
export function appOrigin(): string {
  return config.publicUrl;
}

/** Secure everywhere except a plain-http local origin (dev on localhost). */
export function cookieSecure(): boolean {
  return appOrigin().startsWith("https:");
}

export function pendingCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "Lax" as const,
    maxAge,
    path: PENDING_COOKIE_PATH,
  };
}

/** trim + lowercase. Empty string when the input is not a usable email. */
export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "";
  return e;
}

/** "a***@example.com": enough for the owner to recognize the account, not to read it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Constant-time string equality (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** RFC 7636 S256: base64url(sha256(verifier)), no padding. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Origin check for every state-setting / session-minting POST. Login START
 * endpoints (they plant the state cookie) and the confirm / app-finalize POSTs
 * require `Origin` to equal the hub's public origin: a missing or foreign Origin
 * is refused (a cross-site POST would otherwise plant an attacker-known state).
 * Logout passes `allowMissing: true` (refuse only a foreign Origin).
 */
export function originAllowed(origin: string | null | undefined, opts: { allowMissing?: boolean } = {}): boolean {
  if (!origin) return opts.allowMissing === true;
  return origin === appOrigin();
}

// ── Return URLs ─────────────────────────────────────────────────────────────

/** <REMO_PUBLIC_URL>/auth/callback?state=..[&code_challenge=..&code_challenge_method=S256]
 *  for the web, remo-code://auth/callback?... for the app shell. The portal reads the
 *  PKCE challenge from INSIDE return_url. */
export function getCallbackUrl(params: { state: string; codeChallenge?: string; client?: LoginClient }): string {
  const base = params.client === "app" ? APP_DEEP_LINK_CALLBACK : `${appOrigin()}/auth/callback`;
  const url = new URL(base);
  url.searchParams.set("state", params.state);
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** The hosted login page (passkey, email link, Google per policy) returning to `returnUrl`. */
export function getHostedLoginUrl(returnUrl: string): string {
  const params = new URLSearchParams({ app_id: TITANIUM_APP_SLUG, return_url: returnUrl });
  return `${TITANIUM_AUTH_BASE}/login?${params.toString()}`;
}

/** Where the portal sends the browser back after its own logout. */
export function signedOutReturnUrl(): string {
  return `${appOrigin()}/#/login?signed_out=1`;
}

// ── Pending login / confirm cookies ─────────────────────────────────────────

export interface PendingLogin {
  state: string;
  /** PKCE verifier (hosted login, and every app-shell login). */
  verifier?: string;
  client: LoginClient;
}

export interface NewPendingLogin extends PendingLogin {
  /** Signed `remo_login` cookie value. */
  token: string;
  /** S256 challenge of `verifier`, when PKCE is on. */
  challenge?: string;
}

const b64url = (n: number) => randomBytes(n).toString("base64url");

/** Throws SessionSecretError when SESSION_SECRET is unusable (callers catch). */
export async function newPendingLogin(opts: { pkce: boolean; client?: LoginClient }): Promise<NewPendingLogin> {
  const client: LoginClient = opts.client === "app" ? "app" : "web";
  const state = b64url(32);
  const claims: Record<string, string> = { state, client };
  let verifier: string | undefined;
  if (opts.pkce) {
    verifier = b64url(32); // 43 chars, RFC 7636 unreserved alphabet
    claims.verifier = verifier;
  }
  const token = await signPurposeToken("pending-login", claims, PENDING_LOGIN_TTL_SECONDS);
  return { token, state, client, ...(verifier ? { verifier, challenge: pkceChallenge(verifier) } : {}) };
}

export async function readPendingLogin(token: string | undefined | null): Promise<PendingLogin | null> {
  if (!token) return null;
  const p = await verifyPurposeToken("pending-login", token);
  if (!p || typeof p.state !== "string" || !p.state) return null;
  const client: LoginClient = p.client === "app" ? "app" : "web";
  return {
    state: p.state,
    client,
    ...(typeof p.verifier === "string" && p.verifier ? { verifier: p.verifier } : {}),
  };
}

export interface PendingConfirm {
  email: string;
  accountId?: string;
  /** Random per-confirmation token, rendered into the confirm form and checked on POST. */
  csrf: string;
}

export async function newPendingConfirm(data: { email: string; accountId?: string }): Promise<{ token: string; csrf: string }> {
  const csrf = b64url(32);
  const claims: Record<string, string> = { email: data.email, csrf };
  if (data.accountId) claims.accountId = data.accountId;
  return { token: await signPurposeToken("pending-confirm", claims, PENDING_CONFIRM_TTL_SECONDS), csrf };
}

export async function readPendingConfirm(token: string | undefined | null): Promise<PendingConfirm | null> {
  if (!token) return null;
  const p = await verifyPurposeToken("pending-confirm", token);
  if (!p || typeof p.email !== "string" || !p.email || typeof p.csrf !== "string" || !p.csrf) return null;
  return {
    email: p.email,
    csrf: p.csrf,
    ...(typeof p.accountId === "string" && p.accountId ? { accountId: p.accountId } : {}),
  };
}

// ── Portal calls ────────────────────────────────────────────────────────────

export type SendMagicLinkResult = { ok: true } | { ok: false; error: "rate_limited" | "send_failed" };

export async function sendTitaniumMagicLink(email: string, returnUrl: string): Promise<SendMagicLinkResult> {
  let res: Response;
  try {
    res = await fetch(`${TITANIUM_PORTAL_BASE}/api/auth/send-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, appId: TITANIUM_APP_SLUG, returnUrl }),
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "send_failed" };
  }
  if (res.status === 429) return { ok: false, error: "rate_limited" };
  if (!res.ok) {
    // The body is a fixed code (invalid_app_id | invalid_return_url | unknown_app ...);
    // log the code only, never the email.
    const code = await res
      .json()
      .then((b: any) => (typeof b?.error === "string" ? b.error : "unknown"))
      .catch(() => "unknown");
    console.error("[titanium] send-magic-link refused", { status: res.status, code });
    return { ok: false, error: "send_failed" };
  }
  return { ok: true };
}

export type ExchangeResult =
  | { ok: true; email: string; accountId?: string; licenseKey: string | null }
  | { ok: false; error: "exchange_failed" | "wrong_app" };

/**
 * Redeem a one-time act. Fails closed: the answer must be JSON, must name THIS app
 * (an act minted for another Titanium app, perhaps with a more lenient login policy,
 * is not a login here; a missing appSlug is a mismatch too) and must carry a usable
 * email. `app_slug` is always sent, so the portal refuses another app's act without
 * consuming it; `code_verifier` is sent when the login started with PKCE.
 */
export async function exchangeAct(act: string, codeVerifier?: string): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await fetch(`${TITANIUM_PORTAL_BASE}/api/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ act, app_slug: TITANIUM_APP_SLUG, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }),
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "exchange_failed" };
  }
  if (!res.ok) return { ok: false, error: "exchange_failed" };

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "exchange_failed" };

  if (data.appSlug !== TITANIUM_APP_SLUG) return { ok: false, error: "wrong_app" };

  if (typeof data.email !== "string") return { ok: false, error: "exchange_failed" };
  const email = normalizeEmail(data.email);
  if (!email) return { ok: false, error: "exchange_failed" };

  // Optional (omitted when the portal could not resolve it). The stable user key.
  const accountId = typeof data.accountId === "string" && data.accountId.length > 0 ? data.accountId : undefined;
  // May be null (auth-only). The license path in this hub is still the Keygen
  // JWKS mirror (hub/src/license-gate.ts); the key is not stored here.
  const licenseKey = typeof data.licenseKey === "string" ? data.licenseKey : null;

  return { ok: true, email, licenseKey, ...(accountId ? { accountId } : {}) };
}
