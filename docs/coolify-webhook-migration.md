# Coolify Webhook Migration: Retiring `coolify-ai-monitor`

This runbook walks through migrating the Coolify deployment webhook from the legacy `coolify-ai-monitor` app (port 3032) to remo-code's built-in self-heal stack, soaking both in parallel, and finally retiring the legacy app.

---

## 1. Why retire

Phase 06 absorbed the entire `coolify-ai-monitor` feature surface (G2 deployment-failure capture, G3 log classification, G4 GitHub-issue dispatch, G5 webhook secret management, and G6 triage orchestration) directly into remo-code's scheduler + post-run action framework. With Phase 06 plans 001–008 deployed, every behavior the legacy app provided now runs natively in the hub against a single Postgres database, sharing auth, rate-limiting, and observability with the rest of the platform. There is no longer any reason to operate a second app for Coolify monitoring — retiring it frees port 3032, eliminates a Mongo dependency, and consolidates triage history into `scheduled_task_runs`.

---

## 2. Pre-cutover checklist

Before pointing Coolify at the new endpoint:

- [ ] Phase 04 plan 008 (post-run action framework) is merged to `main` and deployed.
- [ ] Phase 06 plans 001–008 are merged and deployed to `https://app.remo-code.com`.
- [ ] You have generated and stored a fresh webhook secret via **Settings → Integrations → Coolify Webhook** in the remo-code UI. Copy both the secret and your user id.
- [ ] You have confirmed the endpoint accepts a hand-signed payload and returns `202 Accepted`. Run locally:

  ```bash
  USER_ID="<your_user_id>"
  SECRET="<the_webhook_secret>"
  TS=$(date +%s)
  BODY='{"event":"deployment.failed","application":{"uuid":"test"},"deployment":{"uuid":"test"}}'
  SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
  curl -i -X POST "https://app.remo-code.com/api/coolify/webhook/$USER_ID" \
    -H "Content-Type: application/json" \
    -H "X-Coolify-Signature: sha256=$SIG" \
    -H "X-Coolify-Timestamp: $TS" \
    --data "$BODY"
  ```

  Expected response: `HTTP/1.1 202 Accepted`.

---

## 3. Cutover steps

In the Coolify UI:

1. Navigate to **Notifications → Webhooks** (or the per-application webhook tab if the webhook is scoped per app).
2. Edit the existing webhook that currently targets `coolify-ai-monitor`.
3. Change the **Destination URL** from the legacy `http://coolify-ai-monitor:3032/webhook` (or whatever the configured URL is) to:

   ```
   https://app.remo-code.com/api/coolify/webhook/<user_id>
   ```

4. Add the following request headers:
   - `X-Coolify-Signature: sha256=<hex>` — HMAC-SHA256 of `<timestamp>.<raw_body>` keyed by the webhook secret.
   - `X-Coolify-Timestamp: <unix-seconds>` — current unix epoch when the request is sent.
5. Save. Coolify will now fire deployment events at both endpoints if the legacy webhook entry is preserved as a second target; **leave both in place for the soak period**.

---

## 4. Soak period (7 days minimum)

Run both webhook targets in parallel for at least 7 calendar days to verify parity.

**Compare row counts at the end of the soak:**

- New stack (remo-code Postgres):

  ```bash
  psql "$DATABASE_URL" -c "SELECT count(*) FROM scheduled_task_runs WHERE task_kind='triage' AND scheduled_for > now() - interval '7 days';"
  ```

  Call this **count A**.

- Old stack (`coolify-ai-monitor` Mongo or `GET /errors?limit=1000`):

  ```bash
  curl -s http://46.224.61.233:3032/errors?limit=1000 | jq '[.[] | select(.created_at > (now - 7*86400))] | length'
  ```

  Call this **count B**.

**Acceptance:** `|A - B| / max(A, B) < 0.10` (within 10% — accounts for retry de-duplication and per-stack ignore rules).

Additionally:

- [ ] At least one triage run during the soak produced a GitHub issue end-to-end (check the issues tab of the affected repo).
- [ ] No `deployment.failed` events appear in Coolify's webhook delivery log as `4xx`/`5xx` against the remo-code endpoint.

If parity fails, **do not proceed** — investigate missing events before retiring the legacy app.

---

## 5. Retire (stop, do not delete)

Once the soak passes:

1. In the Coolify UI, open the `coolify-ai-monitor` application.
2. Click **Stop** (or `POST /api/v1/applications/<uuid>/stop` via the Coolify API).
3. Wait 5 minutes, then fire one synthetic `deployment.failed` (or wait for the next real failure) and confirm a new row appears in `scheduled_task_runs` with `task_kind='triage'`.
4. Confirm the port is no longer listening: `curl -m 5 http://46.224.61.233:3032/health` should return connection refused.
5. **Do NOT delete the application for 30 days.** Keep the stopped app + its Mongo volume intact as a rollback window. Schedule deletion for **2026-06-24** (or 30 days after the stop date — update this date when you stop the app).
6. In the Coolify webhook UI, delete the legacy webhook target so only the remo-code URL remains active.

**Rollback:** If a regression appears within the 30-day window, restart the `coolify-ai-monitor` app in Coolify and re-add the legacy webhook target. No data loss — Mongo volume is preserved.

---

## 6. Port-map cleanup

Plan **`06-PLAN-010-tests-and-docs`** owns the docs cleanup, including removing port `3032` (coolify-ai-monitor) from the authoritative port map in `~/.claude/CLAUDE.md` and updating any project README references. Do not edit the port map as part of this plan — plan 010 batches that with the rest of the Phase 06 doc work.

---

## Appendix: signature scheme reference

The hub verifies signatures with the canonical recipe used by Stripe, GitHub, and most modern webhook providers:

```
signed_payload   = <timestamp> + "." + <raw_request_body>
expected_sig     = hex(hmac_sha256(secret, signed_payload))
header           = "sha256=" + expected_sig
```

The hub rejects:
- Requests older than 5 minutes (replay protection — uses `X-Coolify-Timestamp`).
- Requests with a missing or malformed `X-Coolify-Signature` header.
- Requests whose computed HMAC does not match in constant time.

See `hub/src/api/coolify-webhook.ts` for the implementation.
