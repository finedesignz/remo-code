# QC R10 - CORCH-04 (Codex, read-only; verdict QC-FAIL, 3 MED)

R9 notification MED: resolved (durable email/telegram only, per-owner retry). R9 ticket MED: partly (existing reporter used), new findings:
1. MED signature-only fingerprint + hourly reporter throttle suppresses a second outage's ticket.
2. MED ticket marked done before delivery; a failed send never retried in that outage.
3. MED partial config (token_unset/url_unset) reports once and never retries an undelivered owner notice.
Fix (R11 input): immediate unthrottled reportTriageFindingToAgentautofix returning a positive result, ticketed only on true, in-flight guard; partial-config branch arms a backoff retry until notice and ticket are both delivered.
