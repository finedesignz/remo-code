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
