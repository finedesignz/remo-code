# QC-ADJUDICATION - CORCH-08

## R4 finding 2 (MED): pr.failed notification delivery is at-least-once, not exactly-once

Finding: if Telegram/email succeeds but `finishAafNotify` then fails before recording `sent`, the receiver answers 503,
and a retry after the 5 minute claim expiry sends the notification again; no stable idempotency key reaches the notifier.

Adjudication: accepted as by design, with the only mitigation that is possible inside this phase.

- Exactly-once across a remote send and a local database write is not achievable without an idempotency key honoured
  by the delivery channel. Telegram sendMessage and the email service (emails4agents) expose none, and changing them is
  out of scope (CORCH-08 "Not in this phase": AAF code; shared notifier is used by other subsystems unchanged).
- The two failure modes are asymmetric. Dropping the notification (R1) meant the owner is never told a PR failed and the
  item is silently blocked. A duplicate notification means the owner is told twice. The design therefore chooses
  at-least-once, and the transition itself stays exactly-once (event_id unique, one transaction).
- The duplicate needs a double fault: the send succeeds, the bookkeeping write fails (and fails again on the immediate
  retry the receiver now performs), the sender retries, and 5 minutes elapse so the claim is reclaimable. A claim
  younger than 5 minutes is never re-sent (a fresh `sending` claim answers 503 busy).
- Fencing (claim token) prevents a superseded slow delivery from overwriting the new owner's state, so the extra
  delivery cannot also corrupt `notify_state`.
- A success criterion of the phase is "failed => blocked + one notification" for the normal path, which holds and is
  tested (single, replayed, concurrent, retry-after-failure all yield exactly one delivered notification).

Residual risk: one duplicate owner notification in a double-fault. No data loss, no second transition, no dispatch.
