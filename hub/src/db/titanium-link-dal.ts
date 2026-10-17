// Titanium login → local user linking (own-auth migration).
//
// Rules (titanium-licensing README §3.3 "Stable account id"):
//   1. Find the local user by the stored Titanium accountId
//      (`users.titanium_account_id`, UNIQUE where not null).
//   2. Else by the Titanium-verified, normalized (trim + lowercase) email.
//      More than one local row for that normalized email (the column is unique
//      only case-sensitively) is AMBIGUOUS: refuse, never guess.
//   3. On first sight attach the accountId to the row found by email. A row that
//      already carries a DIFFERENT accountId is never overwritten: the login is
//      refused (fail closed, an operator decides).
//   4. Never create a second user for a known email. A user is created ONLY by the
//      first-user bootstrap: the users table is empty AND the verified email equals
//      REMO_BOOTSTRAP_ADMIN_EMAIL (created as role 'admin', no password). There is
//      no open self-signup.
//
// Everything runs in one transaction under a transaction-scoped advisory lock so
// two concurrent first logins for the same identity cannot both attach / create.

import { sql } from "./postgres.ts";

export type TitaniumLinkResult =
  | { ok: true; userId: string; linked: "account_id" | "email" | "email_attached" | "bootstrap_admin" }
  | { ok: false; reason: "no_account" | "account_conflict" | "account_ambiguous" };

const LINK_LOCK_KEY = "remo-code:titanium-link";

export async function linkTitaniumLogin(opts: {
  email: string;
  accountId?: string;
  bootstrapAdminEmail?: string;
}): Promise<TitaniumLinkResult> {
  const email = opts.email.trim().toLowerCase();
  const accountId = opts.accountId && opts.accountId.length > 0 ? opts.accountId : undefined;
  const bootstrapEmail = (opts.bootstrapAdminEmail ?? "").trim().toLowerCase();

  return sql.begin(async (tx) => {
    // One global lock: logins are rare, and it serializes attach + bootstrap.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${LINK_LOCK_KEY}))`;

    if (accountId) {
      const byAccount = await tx<{ id: string }[]>`
        SELECT id FROM users WHERE titanium_account_id = ${accountId} LIMIT 1
      `;
      if (byAccount.length > 0) return { ok: true, userId: byAccount[0].id, linked: "account_id" } as const;
    }

    const byEmail = await tx<{ id: string; titanium_account_id: string | null }[]>`
      SELECT id, titanium_account_id FROM users
       WHERE lower(btrim(email)) = ${email}
       FOR UPDATE
    `;
    if (byEmail.length > 1) return { ok: false, reason: "account_ambiguous" } as const;

    if (byEmail.length === 1) {
      const row = byEmail[0];
      if (!accountId) return { ok: true, userId: row.id, linked: "email" } as const;
      // Never overwrite a different stored accountId (step 1 already covered "same").
      if (row.titanium_account_id && row.titanium_account_id !== accountId) {
        return { ok: false, reason: "account_conflict" } as const;
      }
      await tx`
        UPDATE users
           SET titanium_account_id = ${accountId},
               titanium_email = ${email},
               updated_at = now()
         WHERE id = ${row.id} AND titanium_account_id IS NULL
      `;
      return { ok: true, userId: row.id, linked: "email_attached" } as const;
    }

    // Unknown email. Only the first-user bootstrap may create an account.
    if (bootstrapEmail && email === bootstrapEmail) {
      const count = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM users`;
      if (count[0].n === 0) {
        const created = await tx<{ id: string }[]>`
          INSERT INTO users (email, password_hash, role, titanium_account_id, titanium_email)
          VALUES (${email}, NULL, 'admin', ${accountId ?? null}, ${email})
          RETURNING id
        `;
        return { ok: true, userId: created[0].id, linked: "bootstrap_admin" } as const;
      }
    }
    return { ok: false, reason: "no_account" } as const;
  }) as Promise<TitaniumLinkResult>;
}
