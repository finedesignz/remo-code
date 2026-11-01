# Summary

Sign-in now happens only on the Titanium Labs page. Deleted: in-app email form, POST /auth/email, the legacy
password / own-magic-link / finalize-mobile routes, /api/setup (password first-admin), Bearer-JWT login on REST and
/ws/client, ALLOW_LEGACY_LOGIN / LEGACY_MAGIC_LINK_LOGIN / MAGIC_LINK_SECRET, the migrate-users script, SetupForm,
AuthCallback. Kept (inert): users.password_hash column, auth_handoff_tokens table. Added: app-shell start leg
(POST /auth/start {client:"app"} -> {url}), titanium-redirect-only.test.ts.

Verification: bun run check-baseline OK (fail=0); touched hub tests pass; new tests fail on origin/main (mutation check).
Follow-ups: .env.example rows (file is read-denied here), mobile/tauri lib.rs legacy finalize-mobile branch + README,
hub/package.json bcrypt dependency, TITANIUM_BYPASS license switch (S2), portal logoUrl/brandColor.
