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
const titaniumAccountId = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || process.env.TITANIUM_ACCOUNT_ID || "";
const titaniumProductId = process.env.TITANIUM_KEYGEN_PRODUCT_ID || process.env.TITANIUM_PRODUCT_ID || "";
const titaniumPortalToken = process.env.TITANIUM_KEYGEN_PORTAL_TOKEN || process.env.TITANIUM_PORTAL_TOKEN || "";
const titaniumAdminToken =
  process.env.TITANIUM_KEYGEN_ADMIN_TOKEN ||
  process.env.TITANIUM_ADMIN_TOKEN ||
  titaniumPortalToken;
const magicLinkSecret = requireMinLenIfSet("MAGIC_LINK_SECRET", process.env.MAGIC_LINK_SECRET, 32);
const sessionSecret = requireMinLenIfSet("SESSION_SECRET", process.env.SESSION_SECRET, 32);
const allowLegacyLogin = parseBool(process.env.ALLOW_LEGACY_LOGIN, true);
// Optional Titanium -> hub webhook for license-state changes. Inert (route
// returns 503) until Titanium ships the webhook and the secret is provisioned.
const titaniumWebhookSecret = requireMinLenIfSet(
  "TITANIUM_WEBHOOK_SECRET",
  process.env.TITANIUM_WEBHOOK_SECRET,
  16,
);

export const config = {
  port: parseInt(process.env.PORT || "3040"),
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/remocode",
  jwtSecret: process.env.JWT_SECRET || "",
  allowedOrigins: (process.env.HUB_ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(s => s.trim()),
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
};
