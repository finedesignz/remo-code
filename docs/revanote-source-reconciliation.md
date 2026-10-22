# Retiring obsolete Revanote intake records

`annotations.status = 'archived'` retains the intake record and its run history
when an operator has verified that the source annotation is deleted, dismissed,
or already resolved. This is not a successful fix: do not set `resolved_at`, send
a completion callback, or invent a commit SHA.

Archived records remain available in the annotations API, including the
`?status=archived` filter. Normal webhook redelivery, dispatch, manual retry, and
late run finalization cannot reactivate them. Stall and quiet-watch queries
already select only actionable states and therefore exclude archived records.

Before an operator archives a record:

1. Verify the database, role, server, owner and exact source annotation ID.
2. Read the source state again. A connector timeout or permission-denied response
   is not evidence of deletion; verify absence with the authoritative source.
3. Back up the intake row and run history. Refuse active sessions or recent runs.
4. In one transaction, lock the selected intake rows, compare their current state
   with the snapshot, record `skip_reason = 'source_deleted'`, `source_dismissed`,
   or `source_resolved`, set status to `archived`, clear `current_run_id`, and cancel
   only their obsolete in-flight runs with the same reason and a finish time.
5. Read back the exact rows and active backlog counts. Do not replay unrelated work.

Restoring archived work requires a deliberate operator reconciliation against a
current source annotation; the normal retry endpoint rejects it with HTTP 409.
