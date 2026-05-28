// Phase 07-A: Titanium config additions.
//
// New env vars validated at module-load (matches jwt.ts pattern). Boot fails
// fast with a clear error naming the missing/invalid var.
//
// Optional vars (TITANIUM_KEYGEN_*): the entire titanium config block is
// OPTIONAL today. The hub stays bootable without it for the duration of Plan A.
// Only when titanium-client is actually used (Plan C+) does the absence of
// these vars surface as a clear runtime error. Validation here ONLY fires when
// the var IS set (e.g. an invalid URL is rejected even if titanium is otherwise
// off). This mirrors the OPENAI_API_KEY pattern already in the file.

function parseBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`Invalid boolean env value: ${JSON.stringify(v)} (expected true|false|1|0)`);
}

function parsePositiveInt(name: string, v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(v)}`);
  }
  return n;
}

function parseUrlOptional(name: string, v: string | undefined): string {
  if (v === undefined || v === "") return "";
  try {
    new URL(v);
  } catch {
    throw new Error(`${name} must be a valid URL; got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireMinLenIfSet(name: string, v: string | undefined, min: number): string {
  if (v === undefined || v === "") return "";
  if (v.length < min) throw new Error(`${name} must be at least ${min} characters`);
  return v;
}

const titaniumKeygenApiUrl = parseUrlOptional("TITANIUM_KEYGEN_API_URL", process.env.TITANIUM_KEYGEN_API_URL);
const titaniumLicenseCacheTtlSeconds = parsePositiveInt(
  "TITANIUM_LICENSE_CACHE_TTL_SECONDS",
  process.env.TITANIUM_LICENSE_CACHE_TTL_SECONDS,
  300,
);
const titaniumAccountId = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || "";
const titaniumProductId = process.env.TITANIUM_KEYGEN_PRODUCT_ID || "";
const titaniumPortalToken = process.env.TITANIUM_KEYGEN_PORTAL_TOKEN || "";
const titaniumAdminToken = process.env.TITANIUM_KEYGEN_ADMIN_TOKEN || titaniumPortalToken;
const magicLinkSecret = requireMinLenIfSet("MAGIC_LINK_SECRET", process.env.MAGIC_LINK_SECRET, 32);
const sessionSecret = requireMinLenIfSet("SESSION_SECRET", process.env.SESSION_SECRET, 32);
const allowLegacyLogin = parseBool(process.env.ALLOW_LEGACY_LOGIN, true);
// Phase 07-D escape hatch: when LICENSE_REQUIRED=false, requireActiveLicense
// short-circuits to permissive mode (logs a warning once at boot). Used while
// Keygen JWKS endpoint is unhealthy so identity/REST routes don't 402.
const licenseRequired = parseBool(process.env.LICENSE_REQUIRED, true);
// Phase 07 escape hatch (2026-05-26): TITANIUM_BYPASS=true disables JWKS warm
// at boot, short-circuits the license gate, and 503s the magic-link endpoints.
// Used while Keygen CE JWKS endpoint is unavailable. Legacy bcrypt login
// (ALLOW_LEGACY_LOGIN=true) remains the only working auth path under bypass.
const titaniumBypass = parseBool(process.env.TITANIUM_BYPASS, false);
// Bug B (2026-05-28) — when the last web subscriber for a session leaves, wait
// this many seconds before sending `shutdown` to the agent so its runner is
// terminated (idle_no_subscribers). Cancelled if a new subscriber arrives
// inside the window. Default 300s (5 min) is conservative — covers refreshes
// + grid-view tab swaps. 0 disables idle teardown entirely.
const sessionIdleGraceSeconds = (() => {
  const v = process.env.REMO_SESSION_IDLE_GRACE_SECONDS;
  if (v === undefined || v === "") return 300;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`REMO_SESSION_IDLE_GRACE_SECONDS must be a non-negative integer; got ${JSON.stringify(v)}`);
  }
  return n;
})();
// Phase 12.1: Tauri mobile WebView origins. iOS WKWebView shows
// `tauri://localhost`; Android System WebView shows `https://tauri.localhost`.
// Treated as additional first-party origins (CORS allow + Tauri cookie variant).
// Disable only for debug isolation — default ON.
const mobileTauriOriginsEnabled = parseBool(process.env.MOBILE_TAURI_ORIGINS_ENABLED, true);
const MOBILE_TAURI_ORIGINS = ["tauri://localhost", "https://tauri.localhost"] as const;
// Placeholders for Universal Links / Android App Links. Defaults keep the
// `.well-known/*` routes serving in dev where the real team id / fingerprint
// have not yet been provisioned.
const mobileAppleTeamId = process.env.MOBILE_APPLE_TEAM_ID || "TEAMID";
const mobileAndroidSha256Fingerprint =
  process.env.MOBILE_ANDROID_SHA256_FINGERPRINT || "SHA256_PLACEHOLDER";
const mobileBundleId = process.env.MOBILE_BUNDLE_ID || "com.finedesignz.remo-code";
// Optional Titanium -> hub webhook for license-state changes. Inert (route
// returns 503) until Titanium ships the webhook and the secret is provisioned.
const titaniumWebhookSecret = requireMinLenIfSet(
  "TITANIUM_WEBHOOK_SECRET",
  process.env.TITANIUM_WEBHOOK_SECRET,
  16,
);

// Phase 12: Telegram bridge. All three are optional — the bridge no-ops
// cleanly when botToken is unset (UI renders a "not enabled" card). Boot
// emits a single warning if exactly one of botToken / webhookSecret is set.
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramWebhookSecret = requireMinLenIfSet(
  "TELEGRAM_WEBHOOK_SECRET",
  process.env.TELEGRAM_WEBHOOK_SECRET,
  16,
);
const telegramBotUsername = process.env.TELEGRAM_BOT_USERNAME || "";
if ((telegramBotToken && !telegramWebhookSecret) || (!telegramBotToken && telegramWebhookSecret)) {
  console.warn(
    "[config] Telegram bridge partially configured: set BOTH TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET, or neither.",
  );
}

export const config = {
  port: parseInt(process.env.PORT || "3040"),
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/remocode",
  jwtSecret: process.env.JWT_SECRET || "",
  allowedOrigins: (() => {
    const base = (process.env.HUB_ALLOWED_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (mobileTauriOriginsEnabled) {
      for (const o of MOBILE_TAURI_ORIGINS) if (!base.includes(o)) base.push(o);
    }
    return base;
  })(),
  mobileTauriOriginsEnabled,
  mobileTauriOrigins: [...MOBILE_TAURI_ORIGINS] as string[],
  mobileAppleTeamId,
  mobileAndroidSha256Fingerprint,
  mobileBundleId,
  // Optional: OPENAI_API_KEY enables POST /api/transcribe (Whisper voice-to-text).
  // Optional: OPENAI_TRANSCRIBE_MODEL overrides the default 'whisper-1'.
  openaiApiKey: process.env.OPENAI_API_KEY || "",

  // Phase 07-A: Titanium Licensing config block. All fields are strings that
  // default to "" when unset; consumers that require a value (e.g. warmJwksCache,
  // verifyLicenseJwt) must assert non-empty themselves and emit a clear error.
  titanium: {
    keygenApiUrl: titaniumKeygenApiUrl,
    accountId: titaniumAccountId,
    productId: titaniumProductId,
    portalToken: titaniumPortalToken,
    // Admin token is script-time only (migration job). Runtime callers MUST
    // NOT depend on it. The portal token is accepted as a fallback because the
    // migration runbook provisions TITANIUM_KEYGEN_PORTAL_TOKEN with admin scope.
    adminToken: titaniumAdminToken,
    redisUrl: process.env.TITANIUM_REDIS_URL || "",
    licenseCacheTtlSeconds: titaniumLicenseCacheTtlSeconds,
  },
  magicLinkSecret,
  sessionSecret,
  allowLegacyLogin,
  titaniumWebhookSecret,
  licenseRequired,
  titaniumBypass,
  sessionIdleGraceSeconds,

  // Phase 12: Telegram bridge. Feature is gated off when botToken === "".
  telegram: {
    botToken: telegramBotToken,
    webhookSecret: telegramWebhookSecret,
    botUsername: telegramBotUsername,
  },
};
