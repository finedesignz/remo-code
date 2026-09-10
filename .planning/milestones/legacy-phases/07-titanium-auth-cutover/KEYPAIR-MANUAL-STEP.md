# Keygen Account Keypair — Manual SSH Step Required

## Why this exists

Keygen CE generates the per-account Ed25519 signing keypair via a `before_create :generate_ed25519_keys!` model callback on `Account.create!`. The prod account `62ad28e5-2ce7-49d6-8170-ae6fa6584c86` (`titaniumlabs-us`, created 2026-04-21) is missing its keypair — `GET /v1/accounts/:id/.well-known/jwks.json` returns 404 and `GET /v1/accounts/:id/keys` returns `{"data":[]}`. Most likely the account was inserted via SQL import rather than `Account.create!`, so the callback never fired.

Neither the Keygen public API nor the Coolify v1 API exposes a way to fix this remotely:

- Keygen API: `Account` serializer does not expose `ed25519_*` fields and there is no admin-side mutation endpoint for them. `POST /v1/accounts/:id/keys` is for **license-keys**, not account signing keys (returns 400 "unpermitted parameter").
- Coolify API: no `/execute`, `/exec`, or `/command` endpoint on applications (verified, all 404).

The fix has to be a one-line `rails runner` inside the running container, via SSH to the Coolify host.

## What to run

SSH into the Coolify host (`46.224.61.233`), then:

```bash
# Find the running keygen container
docker ps --filter 'name=zdknaz3bm51m3gnz7i125qyn' --format '{{.ID}} {{.Names}}'

# Run the regen (use the container ID from above, or the full keygen-ce service name)
docker exec -it <container_id> bundle exec rails runner \
  "a = Account.find('62ad28e5-2ce7-49d6-8170-ae6fa6584c86'); a.regenerate_ed25519_keys!; a.save!; puts a.ed25519_public_key"
```

The output is the hex-encoded Ed25519 public key (64 chars). Capture it for the record.

## Verify

```bash
curl -sS -i "https://keygen.titaniumlabs.us/v1/accounts/62ad28e5-2ce7-49d6-8170-ae6fa6584c86/.well-known/jwks.json"
```

Expect: `200` with a JWKS body containing `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"...","x":"..."}]}`.

## After it goes 200

Phase 07 Step 5–8 (env writes, redeploy, migration dry-run / apply, D14 trigger) can resume — none of those depend on anything beyond JWKS being live.

## References

- Account model: https://github.com/keygen-sh/keygen-api/blob/master/app/models/account.rb (lines 78, 95, 430–441)
- Setup task: https://github.com/keygen-sh/keygen-api/blob/master/lib/tasks/keygen/setup.rake
- Titanium Phase 08 Stage A: `C:/Users/artic/GitHub/titanium-licensing-feat-app-onboarding/.planning/phases/08-app-onboarding/PLAN.md`
