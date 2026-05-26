/**
 * Phase 07-E: One-shot user migration job — link every remo-code user to a
 * Titanium Licensing (Keygen CE) subject + send the magic-link bootstrap email.
 *
 * Per 07-CONTEXT.md "Email-collision policy" and 07-PLAN-E:
 *
 *   For each user row WHERE titanium_subject IS NULL:
 *     1. Titanium lookup by email (admin slice).
 *     2. NOT FOUND
 *          → keygenAdmin.createUser({ email, metadata: { remo_code_user_id, app_slug:'remo-code' } })
 *          → dal.linkTitaniumSubject(user.id, keygen.id, email)
 *          → send "Welcome / set up your remo-code login" magic-link email.
 *     3. FOUND + emailVerified === true
 *          → dal.setPendingVerify(user.id, keygen.id, email)
 *          → send "Verify this is your account" magic-link email.
 *          → DO NOT write titanium_subject — promotion happens on first callback
 *            (see hub/src/api/auth.ts promoteCandidateSubject).
 *     4. FOUND + emailVerified === false
 *          → skip, log `email_unverified`, surface in report. DO NOT touch DB.
 *     5. FOUND + emailVerified == null (Keygen didn't tell us)
 *          → treat as verified-unknown: same as branch 3 (pending_verify path).
 *            Rationale: the magic-link IS the verification (see Plan C callback).
 *
 * Resumability:
 *   - SQL filter `titanium_subject IS NULL` skips already-linked rows.
 *   - `--resend` flag re-sends magic-link to existing `pending_verify` rows.
 *   - Re-running without `--resend` against an already-migrated DB is a no-op.
 *
 * Magic-link parity:
 *   - Reuses signMagicLink from hub/src/api/auth.ts (__testing export). Same
 *     MAGIC_LINK_SECRET, same jti/exp semantics, same /api/auth/login/callback
 *     route. NO duplicated signing logic.
 *
 * Exit codes:
 *   0 → success (including --dry-run)
 *   1 → at least one per-user error reported, run continued
 *   2 → fatal config/connectivity error before any user processed
 *
 * Usage:
 *   bun run hub/scripts/migrate-users-to-titanium.ts                 # dry-run (default)
 *   bun run hub/scripts/migrate-users-to-titanium.ts --apply         # really mutate
 *   bun run hub/scripts/migrate-users-to-titanium.ts --apply --email user@x.com
 *   bun run hub/scripts/migrate-users-to-titanium.ts --apply --batch-size 25 --limit 100
 *   bun run hub/scripts/migrate-users-to-titanium.ts --apply --resend  # re-email pending_verify
 *
 * Output: migration-log.json under .planning/phases/07-titanium-auth-cutover/.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { keygenAdmin as defaultKeygenAdmin } from "../src/titanium-client.ts";
import {
  linkTitaniumSubject as defaultLinkTitaniumSubject,
  setPendingVerify as defaultSetPendingVerify,
} from "../src/db/dal.ts";
import { sendEmail as defaultSendEmail } from "../src/lib/email.ts";
import { __testing as authTesting } from "../src/api/auth.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type UserRow = {
  id: string;
  email: string;
  titanium_subject: string | null;
  titanium_link_status: string | null;
};

export type MigrationAction =
  | "skipped_already_linked"
  | "linked_created"
  | "linked_pending_verify"
  | "email_unverified"
  | "resent_pending_verify"
  | "error";

export interface MigrationDetail {
  user_id: string;
  email: string;
  action: MigrationAction;
  keygen_user_id?: string;
  error?: string;
}

export interface MigrationLog {
  ran_at: string;
  finished_at: string;
  mode: "dry-run" | "apply";
  total_users: number;
  linked_created: number;
  linked_pending_verify: number;
  skipped_already_linked: number;
  email_unverified: number;
  resent_pending_verify: number;
  errors: Array<{ user_id: string; email: string; error: string }>;
  details: MigrationDetail[];
}

export interface MigrationOptions {
  apply: boolean;
  batchSize: number;
  batchDelayMs: number;
  limit: number | null;
  email: string | null;
  resend: boolean;
  outputPath: string;
}

// Injectable seam — tests pass fakes for keygenAdmin / dal / email / row loader
// / public-base / magic-link signer. Production callers leave undefined.
export interface MigrationDeps {
  loadUsers?: (opts: { email: string | null; resend: boolean; limit: number | null }) => Promise<UserRow[]>;
  keygenAdmin?: {
    findUserByEmail: (email: string) => Promise<{ id: string; email: string; emailVerified?: boolean | null } | null>;
    createUser: (input: { email: string; metadata?: Record<string, unknown> }) => Promise<{ id: string; email: string }>;
  };
  linkTitaniumSubject?: (userId: string, subject: string, email: string) => Promise<void>;
  setPendingVerify?: (userId: string, candidateSubject: string, candidateEmail: string) => Promise<void>;
  sendEmail?: (input: { to: string; subject: string; html: string; text: string }) => Promise<boolean>;
  signMagicLink?: (payload: { sub: string; email: string }) => Promise<{ token: string; jti: string; exp: number }>;
  publicBase?: () => string;
  now?: () => Date;
}

// ── Defaults (production wiring) ─────────────────────────────────────────────

function defaultPublicBase(): string {
  return process.env.REMO_PUBLIC_URL || "https://app.remo-code.com";
}

async function defaultLoadUsers(opts: {
  email: string | null;
  resend: boolean;
  limit: number | null;
}): Promise<UserRow[]> {
  const { sql } = await import("../src/db/postgres.ts");
  // The script targets:
  //   - rows where titanium_subject IS NULL (unlinked, including new + pending_verify)
  //   - OR --resend mode: rows in pending_verify (re-mail only)
  // --email overrides everything: single-user mode.
  if (opts.email) {
    return (await sql`
      SELECT id::text AS id, email, titanium_subject, titanium_link_status
        FROM users
       WHERE email = ${opts.email.toLowerCase().trim()}
       LIMIT 1
    `) as unknown as UserRow[];
  }
  if (opts.resend) {
    const limitClause = opts.limit ? sql`LIMIT ${opts.limit}` : sql``;
    return (await sql`
      SELECT id::text AS id, email, titanium_subject, titanium_link_status
        FROM users
       WHERE titanium_link_status = 'pending_verify'
       ORDER BY created_at ASC
       ${limitClause}
    `) as unknown as UserRow[];
  }
  const limitClause = opts.limit ? sql`LIMIT ${opts.limit}` : sql``;
  return (await sql`
    SELECT id::text AS id, email, titanium_subject, titanium_link_status
      FROM users
     WHERE titanium_subject IS NULL
     ORDER BY created_at ASC
     ${limitClause}
  `) as unknown as UserRow[];
}

// ── Email rendering ──────────────────────────────────────────────────────────

const MAGIC_LINK_TTL_MIN = 15;

function renderWelcomeEmail(url: string): { subject: string; html: string; text: string } {
  const subject = "Welcome to remo-code — sign in to finish setup";
  const text =
    `remo-code now uses passwordless sign-in through Titanium Licensing.\n\n` +
    `Click to sign in: ${url}\n\n` +
    `This link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once. ` +
    `If you didn't expect this email, ignore it — your account is unchanged.`;
  const html =
    `<p>remo-code now uses passwordless sign-in through Titanium Licensing.</p>` +
    `<p><a href="${url}">Sign in to remo-code</a></p>` +
    `<p style="color:#888;font-size:12px">This link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once. ` +
    `If you didn't expect this email, ignore it — your account is unchanged.</p>`;
  return { subject, html, text };
}

function renderVerifyEmail(url: string): { subject: string; html: string; text: string } {
  const subject = "Verify your remo-code account with Titanium Licensing";
  const text =
    `An existing Titanium Licensing account was found for your email. ` +
    `To link it to remo-code, click below:\n\n` +
    `Verify and sign in: ${url}\n\n` +
    `This link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once. ` +
    `If you didn't expect this email, ignore it — nothing is linked until you click.`;
  const html =
    `<p>An existing Titanium Licensing account was found for your email.</p>` +
    `<p>To link it to remo-code, click below:</p>` +
    `<p><a href="${url}">Verify and sign in</a></p>` +
    `<p style="color:#888;font-size:12px">This link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once. ` +
    `If you didn't expect this email, ignore it — nothing is linked until you click.</p>`;
  return { subject, html, text };
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): MigrationOptions {
  const defaultOutput = resolve(
    import.meta.dir,
    "../../.planning/phases/07-titanium-auth-cutover/migration-log.json",
  );
  const opts: MigrationOptions = {
    apply: false, // dry-run is the safe default
    batchSize: 50,
    batchDelayMs: 5_000,
    limit: null,
    email: null,
    resend: false,
    outputPath: defaultOutput,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--dry-run") opts.apply = false;
    else if (a === "--resend") opts.resend = true;
    else if (a === "--batch-size") opts.batchSize = Number(argv[++i]);
    else if (a?.startsWith("--batch-size=")) opts.batchSize = Number(a.slice("--batch-size=".length));
    else if (a === "--batch-delay-ms") opts.batchDelayMs = Number(argv[++i]);
    else if (a?.startsWith("--batch-delay-ms=")) opts.batchDelayMs = Number(a.slice("--batch-delay-ms=".length));
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a?.startsWith("--limit=")) opts.limit = Number(a.slice("--limit=".length));
    else if (a === "--email") opts.email = argv[++i] ?? null;
    else if (a?.startsWith("--email=")) opts.email = a.slice("--email=".length);
    else if (a === "--output") opts.outputPath = resolve(argv[++i] ?? defaultOutput);
    else if (a?.startsWith("--output=")) opts.outputPath = resolve(a.slice("--output=".length));
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`[migrate] unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.batchSize) || opts.batchSize <= 0) {
    console.error("[migrate] --batch-size must be a positive integer");
    process.exit(2);
  }
  if (!Number.isFinite(opts.batchDelayMs) || opts.batchDelayMs < 0) {
    console.error("[migrate] --batch-delay-ms must be a non-negative integer");
    process.exit(2);
  }
  if (opts.limit !== null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    console.error("[migrate] --limit must be a positive integer");
    process.exit(2);
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: bun run hub/scripts/migrate-users-to-titanium.ts [flags]

  --dry-run               (default) preview without mutating DB or Keygen
  --apply                 actually mutate — opt in
  --batch-size N          users per batch before delay (default 50)
  --batch-delay-ms N      delay between batches in ms (default 5000)
  --limit N               cap total users processed (optional)
  --email <addr>          single-user mode (smoke test); ignores --limit/--resend
  --resend                re-send magic-link to existing pending_verify rows
  --output <path>         write log JSON here (default .planning/phases/07-.../migration-log.json)
  --help                  show this message`);
}

// ── Core migration ───────────────────────────────────────────────────────────

export async function runMigration(
  options: MigrationOptions,
  injected: MigrationDeps = {},
): Promise<MigrationLog> {
  const deps = {
    loadUsers: injected.loadUsers ?? defaultLoadUsers,
    keygenAdmin: injected.keygenAdmin ?? defaultKeygenAdmin,
    linkTitaniumSubject: injected.linkTitaniumSubject ?? defaultLinkTitaniumSubject,
    setPendingVerify: injected.setPendingVerify ?? defaultSetPendingVerify,
    sendEmail: injected.sendEmail ?? defaultSendEmail,
    signMagicLink: injected.signMagicLink ?? authTesting.signMagicLink,
    publicBase: injected.publicBase ?? defaultPublicBase,
    now: injected.now ?? (() => new Date()),
  };

  const startedAt = deps.now().toISOString();
  const log: MigrationLog = {
    ran_at: startedAt,
    finished_at: startedAt, // updated at end
    mode: options.apply ? "apply" : "dry-run",
    total_users: 0,
    linked_created: 0,
    linked_pending_verify: 0,
    skipped_already_linked: 0,
    email_unverified: 0,
    resent_pending_verify: 0,
    errors: [],
    details: [],
  };

  const users = await deps.loadUsers({
    email: options.email,
    resend: options.resend,
    limit: options.limit,
  });
  log.total_users = users.length;

  if (users.length === 0) {
    console.log(`[migrate] no users to process (mode=${log.mode})`);
    log.finished_at = deps.now().toISOString();
    return log;
  }

  console.log(
    `[migrate] processing ${users.length} user(s) in batches of ${options.batchSize} ` +
      `(mode=${log.mode}, resend=${options.resend})`,
  );

  for (let batchStart = 0; batchStart < users.length; batchStart += options.batchSize) {
    const batch = users.slice(batchStart, batchStart + options.batchSize);
    for (const user of batch) {
      try {
        const detail = await processUser(user, options, deps);
        log.details.push(detail);
        switch (detail.action) {
          case "skipped_already_linked":
            log.skipped_already_linked++;
            break;
          case "linked_created":
            log.linked_created++;
            break;
          case "linked_pending_verify":
            log.linked_pending_verify++;
            break;
          case "email_unverified":
            log.email_unverified++;
            break;
          case "resent_pending_verify":
            log.resent_pending_verify++;
            break;
          case "error":
            // already counted via push to errors below
            break;
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error(`[migrate] error for ${user.email}: ${msg}`);
        log.details.push({
          user_id: user.id,
          email: user.email,
          action: "error",
          error: msg,
        });
        log.errors.push({ user_id: user.id, email: user.email, error: msg });
      }
    }
    // Batch pacing — skip the delay on the last batch.
    if (batchStart + options.batchSize < users.length && options.batchDelayMs > 0) {
      await sleep(options.batchDelayMs);
    }
  }

  log.finished_at = deps.now().toISOString();
  return log;
}

async function processUser(
  user: UserRow,
  options: MigrationOptions,
  deps: Required<MigrationDeps>,
): Promise<MigrationDetail> {
  // Already linked. Idempotency guard for re-runs without --resend.
  if (user.titanium_subject && !options.resend) {
    return { user_id: user.id, email: user.email, action: "skipped_already_linked" };
  }

  // --resend mode: only re-mails pending_verify rows; skip everything else loudly.
  if (options.resend) {
    if (user.titanium_link_status !== "pending_verify") {
      return { user_id: user.id, email: user.email, action: "skipped_already_linked" };
    }
    if (!options.apply) {
      console.log(`[migrate] (dry) WOULD resend pending_verify magic-link to ${user.email}`);
      return { user_id: user.id, email: user.email, action: "resent_pending_verify" };
    }
    await sendMagicLink(user, "verify", deps);
    return { user_id: user.id, email: user.email, action: "resent_pending_verify" };
  }

  // Normal mapping path — lookup in Keygen.
  const existing = await deps.keygenAdmin.findUserByEmail(user.email);

  if (!existing) {
    // Branch 2: create + link.
    if (!options.apply) {
      console.log(`[migrate] (dry) WOULD create+link Keygen user for ${user.email}`);
      return { user_id: user.id, email: user.email, action: "linked_created" };
    }
    const created = await deps.keygenAdmin.createUser({
      email: user.email,
      metadata: { remo_code_user_id: user.id, app_slug: "remo-code" },
    });
    await deps.linkTitaniumSubject(user.id, created.id, user.email);
    await sendMagicLink(user, "welcome", deps);
    console.log(`[migrate] linked_created ${user.email} → keygen=${created.id}`);
    return {
      user_id: user.id,
      email: user.email,
      action: "linked_created",
      keygen_user_id: created.id,
    };
  }

  // Branch 4: explicit unverified — skip.
  if (existing.emailVerified === false) {
    console.warn(`[migrate] email_unverified ${user.email} → keygen=${existing.id} (skipped)`);
    return {
      user_id: user.id,
      email: user.email,
      action: "email_unverified",
      keygen_user_id: existing.id,
    };
  }

  // Branch 3 (or 5: emailVerified unknown → treat as pending). Set pending_verify.
  if (!options.apply) {
    console.log(`[migrate] (dry) WOULD pending_verify ${user.email} → keygen=${existing.id}`);
    return {
      user_id: user.id,
      email: user.email,
      action: "linked_pending_verify",
      keygen_user_id: existing.id,
    };
  }
  await deps.setPendingVerify(user.id, existing.id, user.email);
  await sendMagicLink(user, "verify", deps);
  console.log(`[migrate] linked_pending_verify ${user.email} → keygen=${existing.id}`);
  return {
    user_id: user.id,
    email: user.email,
    action: "linked_pending_verify",
    keygen_user_id: existing.id,
  };
}

async function sendMagicLink(
  user: UserRow,
  kind: "welcome" | "verify",
  deps: Required<MigrationDeps>,
): Promise<void> {
  const { token } = await deps.signMagicLink({ sub: user.id, email: user.email });
  const url = `${deps.publicBase()}/api/auth/login/callback?token=${encodeURIComponent(token)}`;
  const body = kind === "welcome" ? renderWelcomeEmail(url) : renderVerifyEmail(url);
  const ok = await deps.sendEmail({ to: user.email, ...body });
  if (!ok) {
    // sendEmail returns false instead of throwing — keep that contract but
    // promote to an error so the per-user error counter ticks.
    throw new Error("emails4agents send failed (see hub logs)");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[migrate] start mode=${opts.apply ? "APPLY" : "dry-run"} ` +
      `batch=${opts.batchSize}/${opts.batchDelayMs}ms ` +
      `${opts.limit ? `limit=${opts.limit} ` : ""}` +
      `${opts.email ? `email=${opts.email} ` : ""}` +
      `${opts.resend ? "resend " : ""}` +
      `→ ${opts.outputPath}`,
  );

  let log: MigrationLog;
  try {
    log = await runMigration(opts);
  } catch (err: any) {
    console.error(`[migrate] FATAL: ${err?.message ?? err}`);
    process.exit(2);
  }

  // Always write the log, even on partial failure.
  try {
    mkdirSync(dirname(opts.outputPath), { recursive: true });
    writeFileSync(opts.outputPath, JSON.stringify(log, null, 2) + "\n");
    console.log(`[migrate] wrote ${opts.outputPath}`);
  } catch (err: any) {
    console.error(`[migrate] failed to write log: ${err?.message ?? err}`);
  }

  console.log(
    `[migrate] done mode=${log.mode} total=${log.total_users} ` +
      `created=${log.linked_created} pending=${log.linked_pending_verify} ` +
      `skipped=${log.skipped_already_linked} unverified=${log.email_unverified} ` +
      `resent=${log.resent_pending_verify} errors=${log.errors.length}`,
  );

  process.exit(log.errors.length > 0 ? 1 : 0);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.main) {
  await main();
}
