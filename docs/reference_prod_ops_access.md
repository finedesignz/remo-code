# Reference: Prod/Container Ops Inspection Access (global rule 22)

Guard + runbook note for any agent or operator inspecting a running prod/dev container
(hub, supervisor, or any Coolify-hosted resource) — e.g. `docker inspect`, `docker exec env`,
`docker logs`, `printenv`, or the Coolify UI's "Environment Variables" tab.

## Incident reference

2026-11-01: an agent ran `docker inspect` on a Coolify container to debug connectivity and
printed the **full container env** into its own transcript, including `TITANIUM_REDIS_URL`
with its Redis password embedded as URL userinfo (`redis://:<password>@host:port`). That
credential must be rotated via the Coolify `*-redis` resource (tracked separately — rotation
is NOT covered by this doc).

## Rule: never dump raw container env

Any ops inspection of a prod (or shared dev) container — by an agent, a script, or a human
pasting output into chat/a PR/a transcript — **must not** print raw environment *values*.
This applies to `docker inspect <container>` (its `Config.Env` array is the full raw env),
`docker exec <container> env`/`printenv` with no filtering, Coolify's "show values" env UI,
and any log line that echoes `process.env` wholesale.

**Do instead:**

- **Print variable NAMES only.** `docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1` (or the Coolify UI's env list in "keys only" / collapsed view) is sufficient for "is this var set" questions — the overwhelming majority of ops inspection needs.
- **If a value is genuinely needed** (e.g. confirming a URL host/port, not the secret), grep it
  out and redact the sensitive part — never paste the raw line. In particular:
  - Any key matching `*_URL`, `*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*KEY*` (case-insensitive) is
    treated as a credential by default — redact the value, don't print it.
  - A URL carrying userinfo (`scheme://user:pass@host`) must have the userinfo redacted
    (`scheme://[REDACTED]@host`) before it ever appears in a transcript, log, issue, or PR —
    same convention as `hub/src/agentautofix/reporter.ts`'s `scrub()` (which already redacts
    `postgres://…` URLs and token-shaped strings in self-captured errors/stack traces).
- **Never echo `docker inspect`'s full JSON output** (or `Config.Env` from it) verbatim into a
  transcript, chat message, log, commit, or PR description. If a script needs the full struct
  programmatically, keep it in-process (pipe to `jq`/filter immediately) rather than printing it
  and re-parsing from a pasted transcript.

## Why this matters for agents specifically

An agent's tool output (stdout/stderr of `docker inspect`/`docker exec`) is not just a human
convenience — it becomes part of the agent's own context/transcript, which may be logged,
reviewed, or (for triage/self-heal flows) forwarded into an issue or chat message. A raw env
dump leaks every credential the container holds into that surface, not just the one var the
agent was trying to check.

Any runbook or script instructing an agent/operator to inspect a prod container's environment
should spell out the filtered form explicitly (names-only, or grep+redact) rather than a bare
`docker inspect`/`env` invocation, so the filtered form is the one that gets copy-pasted.
