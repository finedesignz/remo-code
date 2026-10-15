// Titanium hosted login for the remo-code web app (and the Tauri shell's deep-link
// leg). Mounted at `/auth` (root, NOT under /api): these are top-level browser
// navigations and form posts, so they sit outside the /api/* JSON auth, license
// and CSRF catch-alls on purpose and do their own checks:
//
//   POST /auth/email         SPA email form (JSON {email, client?}). Origin must be
//                            the hub origin. Sets remo_login {state} (+ PKCE for the
//                            app shell) and asks the portal, in the background, to
//                            mail a link. Same answer for every address.
//   POST /auth/start         "Continue with Titanium" (form). Origin must be the hub
//                            origin. remo_login {state, verifier} → 303 hosted login
//                            with return_url=<hub>/auth/callback?state&code_challenge.
//   GET  /auth/callback      ?state&act. state matches remo_login: exchange (+verifier)
//                            and sign in. No match: exchange, park the identity in
//                            remo_confirm (5 min) and 303 /auth/confirm. Nothing is
//                            minted on a GET without a state match.
//   GET  /auth/confirm       "Sign in as a***@x.com?" page.
//   POST /auth/confirm       Origin == hub origin + valid remo_confirm + matching csrf.
//   POST /auth/app-finalize  Tauri shell: {state, act} from the WebView (same cookie
//                            jar as /auth/email). Origin == hub origin, remo_login
//                            client=app, state match, PKCE verifier at exchange.
//                            Never falls back to a confirmation page.
//   POST /auth/logout        Clears the hub session + pending cookies (Origin may be
//                            missing, never foreign) → 303 /auth/signed-out.
//   GET  /auth/signed-out    Auto-submitting top-level POST to the portal logout.
//
// The dashboard session stays the opaque `auth_sessions` cookie (hub/src/session.ts);
// local users are linked by hub/src/db/titanium-link-dal.ts.

import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "../config.ts";
import {
  APP_DEEP_LINK_CALLBACK,
  PENDING_CONFIRM_COOKIE,
  PENDING_CONFIRM_TTL_SECONDS,
  PENDING_LOGIN_COOKIE,
  PENDING_LOGIN_TTL_SECONDS,
  TITANIUM_LOGOUT_URL,
  exchangeAct,
  getCallbackUrl,
  getHostedLoginUrl,
  maskEmail,
  newPendingConfirm,
  newPendingLogin,
  normalizeEmail,
  originAllowed,
  pendingCookieOptions,
  readPendingConfirm,
  readPendingLogin,
  safeEqual,
  sendTitaniumMagicLink,
  signedOutReturnUrl,
} from "../auth/titanium-login.ts";
import { linkTitaniumLogin } from "../db/titanium-link-dal.ts";
import { deleteAuthSession, recordAuthEvent } from "../db/dal.ts";
import { createAndSetSession, destroySession, readSessionCookie } from "../session.ts";
import { clearCsrfCookie, issueCsrfToken, setCsrfCookie } from "../csrf.ts";

export const titaniumAuthRouter = new Hono();

// Test seam: lets unit tests replace the DB-backed linker (no Postgres needed).
type Linker = typeof linkTitaniumLogin;
let _linker: Linker = linkTitaniumLogin;
export function __setLinkerForTesting(fn: Linker | null) {
  _linker = fn ?? linkTitaniumLogin;
}

const LOGIN_PAGE = "/#/login";
const loginError = (code: string) => `${LOGIN_PAGE}?error=${encodeURIComponent(code)}`;

function ipOf(c: Context): string | null {
  return c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

function clearPendingLogin(c: Context) {
  setCookie(c, PENDING_LOGIN_COOKIE, "", pendingCookieOptions(0));
}
function clearPendingConfirm(c: Context) {
  setCookie(c, PENDING_CONFIRM_COOKIE, "", pendingCookieOptions(0));
}

function redirect303(c: Context, location: string) {
  return c.redirect(location, 303);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0b0d12;--card:#151922;--fg:#e6e8ee;--muted:#9aa3b2;--border:#262c38;--accent:#2563eb}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:17px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
.row{display:flex;gap:12px}button{flex:1;height:40px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><div class="card">${body}</div></body></html>`;
}

/**
 * The one place a dashboard session is minted after a Titanium login. Links the
 * local user (refusals become /#/login?error=...), revokes any inbound session
 * row (fresh-session invariant for the step-up gate), creates the opaque session
 * + CSRF cookie. A signing / DB failure is the normal error redirect, never an
 * unhandled 500.
 */
async function completeLogin(
  c: Context,
  identity: { email: string; accountId?: string },
  via: "titanium_state" | "titanium_confirm" | "titanium_app",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ip = ipOf(c);
  const ua = c.req.header("user-agent") ?? null;
  try {
    const link = await _linker({
      email: identity.email,
      ...(identity.accountId ? { accountId: identity.accountId } : {}),
      bootstrapAdminEmail: config.bootstrapAdminEmail,
    });
    if (!link.ok) {
      try {
        await recordAuthEvent({ eventType: "login_failed", ip, userAgent: ua, metadata: { reason: link.reason, method: via } });
      } catch {}
      return { ok: false, error: link.reason };
    }

    const inbound = readSessionCookie(c);
    if (inbound) {
      try { await deleteAuthSession(inbound); } catch {}
    }
    const { token } = await createAndSetSession(c, { userId: link.userId, ip, userAgent: ua });
    setCsrfCookie(c, issueCsrfToken(token));
    try {
      await recordAuthEvent({
        userId: link.userId,
        eventType: "login_success",
        ip,
        userAgent: ua,
        metadata: { method: via, linked: link.linked, account_id_present: !!identity.accountId, revoked_prior_session: !!inbound },
      });
    } catch {}
    return { ok: true };
  } catch (err) {
    console.error("[auth] titanium login mint failed", { reason: err instanceof Error ? err.name : "unknown" });
    return { ok: false, error: "server_misconfigured" };
  }
}

// ── POST /auth/email ────────────────────────────────────────────────────────
titaniumAuthRouter.post("/email", async (c) => {
  if (!originAllowed(c.req.header("origin"))) return c.json({ error: "origin_not_allowed" }, 403);
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; client?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!email) return c.json({ error: "invalid_email" }, 400);
  const client = body?.client === "app" ? "app" : "web";

  let pending: Awaited<ReturnType<typeof newPendingLogin>>;
  try {
    // Web: no PKCE on the email path (a link opened on another device must still
    // work, through the confirmation page). App shell: PKCE always, the exchange
    // happens in the same WebView cookie jar that holds the verifier.
    pending = await newPendingLogin({ pkce: client === "app", client });
  } catch {
    return c.json({ error: "server_misconfigured" }, 503);
  }
  const returnUrl = getCallbackUrl({ state: pending.state, codeChallenge: pending.challenge, client });
  setCookie(c, PENDING_LOGIN_COOKIE, pending.token, pendingCookieOptions(PENDING_LOGIN_TTL_SECONDS));

  // Same answer for every address and for a rate-limited request: the portal call
  // runs AFTER the response, so neither the body nor the timing is an oracle.
  const rateLimited = c.get("rateLimited" as never) === true;
  if (!rateLimited) {
    queueMicrotask(() => {
      sendTitaniumMagicLink(email, returnUrl)
        .then((r) => { if (!r.ok) console.error("[auth] titanium magic link not sent", { error: r.error }); })
        .catch(() => {});
    });
  }
  return c.json({ ok: true });
});

// ── POST /auth/start ────────────────────────────────────────────────────────
titaniumAuthRouter.post("/start", async (c) => {
  if (!originAllowed(c.req.header("origin"))) return redirect303(c, loginError("origin_not_allowed"));
  try {
    const pending = await newPendingLogin({ pkce: true, client: "web" });
    const returnUrl = getCallbackUrl({ state: pending.state, codeChallenge: pending.challenge });
    setCookie(c, PENDING_LOGIN_COOKIE, pending.token, pendingCookieOptions(PENDING_LOGIN_TTL_SECONDS));
    return redirect303(c, getHostedLoginUrl(returnUrl));
  } catch (err) {
    console.error("[auth] titanium login start failed", { reason: err instanceof Error ? err.name : "unknown" });
    return redirect303(c, loginError("server_misconfigured"));
  }
});

// ── GET /auth/callback ──────────────────────────────────────────────────────
titaniumAuthRouter.get("/callback", async (c) => {
  try {
    const act = c.req.query("act");
    if (!act) return c.redirect(loginError("missing_act"), 302);

    const stateParam = c.req.query("state");
    const pending = await readPendingLogin(getCookie(c, PENDING_LOGIN_COOKIE));
    const matched = !!pending && pending.client === "web" && !!stateParam && safeEqual(stateParam, pending.state);

    if (matched) {
      clearPendingLogin(c);
      const result = await exchangeAct(act, pending!.verifier);
      if (!result.ok) {
        await destroySession(c);
        return c.redirect(loginError(result.error), 302);
      }
      const done = await completeLogin(c, result, "titanium_state");
      if (!done.ok) {
        await destroySession(c);
        return c.redirect(loginError(done.error), 302);
      }
      return c.redirect("/", 302);
    }

    // Not started in this browser (another device, or a link someone handed us).
    // Redeem, but never mint on this GET: ask the user to confirm the account.
    const result = await exchangeAct(act);
    if (!result.ok) return c.redirect(loginError(result.error), 302);
    const { token } = await newPendingConfirm(result);
    setCookie(c, PENDING_CONFIRM_COOKIE, token, pendingCookieOptions(PENDING_CONFIRM_TTL_SECONDS));
    // An existing session is left alone: declining the confirmation keeps it.
    return redirect303(c, "/auth/confirm");
  } catch (err) {
    console.error("[auth] titanium callback failed", { reason: err instanceof Error ? err.name : "unknown" });
    return c.redirect(loginError("server_misconfigured"), 302);
  }
});

// ── GET /auth/confirm ───────────────────────────────────────────────────────
titaniumAuthRouter.get("/confirm", async (c) => {
  const pending = await readPendingConfirm(getCookie(c, PENDING_CONFIRM_COOKIE));
  if (!pending) return c.redirect(loginError("confirm_expired"), 302);
  c.header("Cache-Control", "no-store");
  return c.html(
    page(
      "Confirm sign-in · Remo Code",
      `<h1>Sign in as ${escapeHtml(maskEmail(pending.email))}?</h1>
<p>This sign-in link was opened in a browser that did not request it. Continue only if this is your account and you just asked for a sign-in link.</p>
<form method="POST" action="/auth/confirm" class="row">
<input type="hidden" name="csrf" value="${escapeHtml(pending.csrf)}">
<button type="submit" name="intent" value="confirm" class="primary">Sign in</button>
<button type="submit" name="intent" value="cancel">Cancel</button>
</form>`,
    ),
  );
});

// ── POST /auth/confirm ──────────────────────────────────────────────────────
titaniumAuthRouter.post("/confirm", async (c) => {
  try {
    if (!originAllowed(c.req.header("origin"))) {
      clearPendingConfirm(c);
      return redirect303(c, loginError("confirm_failed"));
    }
    const form = await c.req.parseBody().catch(() => null);
    const csrf = form?.csrf;
    const intent = form?.intent;
    const pending = await readPendingConfirm(getCookie(c, PENDING_CONFIRM_COOKIE));
    clearPendingConfirm(c);
    if (!pending || typeof csrf !== "string" || !safeEqual(csrf, pending.csrf)) {
      return redirect303(c, loginError("confirm_expired"));
    }
    if (intent !== "confirm") return redirect303(c, LOGIN_PAGE);

    clearPendingLogin(c);
    const done = await completeLogin(c, pending, "titanium_confirm");
    if (!done.ok) {
      await destroySession(c);
      return redirect303(c, loginError(done.error));
    }
    return redirect303(c, "/");
  } catch (err) {
    console.error("[auth] titanium confirm failed", { reason: err instanceof Error ? err.name : "unknown" });
    return redirect303(c, loginError("server_misconfigured"));
  }
});

// ── POST /auth/app-finalize (Tauri shell deep link) ─────────────────────────
// The shell receives remo-code://auth/callback?state&code_challenge..&act and POSTs
// {state, act} from the WebView, whose cookie jar holds the remo_login cookie set by
// /auth/email {client:"app"}. tauri.md: PKCE + app_slug are mandatory on this leg (a
// custom-scheme return is owned by no registered app). A deep link that does not
// match this device's pending login is refused outright, no confirmation fallback.
titaniumAuthRouter.post("/app-finalize", async (c) => {
  try {
    if (!originAllowed(c.req.header("origin"))) return c.json({ error: "origin_not_allowed" }, 403);
    const body = (await c.req.json().catch(() => null)) as { state?: unknown; act?: unknown } | null;
    const act = typeof body?.act === "string" ? body.act : "";
    const state = typeof body?.state === "string" ? body.state : "";
    if (!act || !state) return c.json({ error: "missing_act" }, 400);

    const pending = await readPendingLogin(getCookie(c, PENDING_LOGIN_COOKIE));
    if (!pending || pending.client !== "app" || !pending.verifier || !safeEqual(state, pending.state)) {
      return c.json({ error: "state_mismatch" }, 401);
    }
    clearPendingLogin(c);
    const result = await exchangeAct(act, pending.verifier);
    if (!result.ok) return c.json({ error: result.error }, 401);
    const done = await completeLogin(c, result, "titanium_app");
    if (!done.ok) {
      await destroySession(c);
      return c.json({ error: done.error }, done.error === "server_misconfigured" ? 503 : 403);
    }
    return c.json({ ok: true });
  } catch (err) {
    console.error("[auth] titanium app finalize failed", { reason: err instanceof Error ? err.name : "unknown" });
    return c.json({ error: "server_misconfigured" }, 503);
  }
});

// ── POST /auth/logout ───────────────────────────────────────────────────────
titaniumAuthRouter.post("/logout", async (c) => {
  if (!originAllowed(c.req.header("origin"), { allowMissing: true })) {
    return c.json({ error: "origin_not_allowed" }, 403);
  }
  await destroySession(c);
  clearCsrfCookie(c);
  clearPendingLogin(c);
  clearPendingConfirm(c);
  try {
    await recordAuthEvent({ eventType: "logout", ip: ipOf(c), userAgent: c.req.header("user-agent") ?? null, metadata: { via: "titanium_logout" } });
  } catch {}
  return redirect303(c, "/auth/signed-out");
});

// ── GET /auth/signed-out ────────────────────────────────────────────────────
// Ends the Titanium portal session too, so "Continue with Titanium" cannot sign the
// user straight back in on a shared machine. Top-level form POST (the portal's
// cookies are host-only SameSite=Lax: a fetch or iframe would not carry them).
titaniumAuthRouter.get("/signed-out", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(
    page(
      "Signed out · Remo Code",
      `<h1>Signed out of Remo Code</h1>
<p>Ending your Titanium session…</p>
<form id="titanium-logout" method="POST" action="${escapeHtml(TITANIUM_LOGOUT_URL)}">
<input type="hidden" name="return_url" value="${escapeHtml(signedOutReturnUrl())}">
<button type="submit">Sign out of Titanium</button>
</form>
<script>document.getElementById('titanium-logout').submit()</script>`,
    ),
  );
});

export const __testing = { APP_DEEP_LINK_CALLBACK, escapeHtml };
