# QC adjudication - CORCH-04

## R6 #1 (part): "processing blocks keepalive consumption; a 3 minute processing time aborts a healthy stream"

Judged BY DESIGN, not changed.

- Processing one event is: at most one board read per enrolled project (each read byte-capped at 8 MB and aborted by
  the same inactivity timer if the console hangs), one derivation, one transaction. A legitimate event is seconds, not
  minutes; 3 minutes of silence from the pipeline is itself the signal that the console or the database is wedged.
- The consequence of the abort is the designed fail-closed path: nothing partial is written (the transaction re-checks
  liveness before commit), ONE notification per outage, backoff reconnect, and a fresh snapshot that recomputes and
  idempotently re-applies everything. Nothing is lost: derivation is a pure function of the board, the upsert is
  idempotent, and (R6 fix) the re-snapshot re-fires evaluation for every user with a queued candidate.
- Decoupling consumption from processing (a second queue between the SSE reader and the processor) would add a
  buffering layer whose bound and drop policy are new failure modes (an unbounded queue is a memory risk; a bounded one
  must drop events, and a dropped event is exactly the stale-board condition fail-closed is meant to avoid). Rejected as
  more risk than the abort-and-resnapshot it would replace.

## R8 #1 (SUPERSEDED by the R9 fix: durable-channel delivery and per-owner retry; the judgement below no longer stands): "inapp counts as delivered for an offline owner; track durable per-owner delivery and retry only undelivered recipients"

Judged BY DESIGN, not changed.

- The spec is "one owner notification per outage (`fanOutNotify`)" (CORCH-R1.16). `fanOutNotify` is the shared owner
  notifier every CORCH, heal and orchestrator alert already uses; what it reports as `delivered` is its contract, and
  its `inapp` channel persists for the owner's next connect. Re-deriving a stricter notion of delivery in this one
  caller would fork the contract and still not make delivery certain (email, Telegram and push have no read receipts).
- R7 already closed the real gap in this caller: if no owner at all was reached on any channel, the outage stays
  un-notified and the next failure retries. A per-recipient ack ledger would need new persistent state (a table or a
  store) for a rare partial-delivery case, against the additive, no-new-DDL scope of this phase.
