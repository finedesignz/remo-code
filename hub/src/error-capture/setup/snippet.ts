/**
 * Error-capture reporter snippet generator + idempotent injector (W5).
 *
 * IMPORTANT — why this is NOT the official Sentry SDK:
 *   The hub issues error-project ids as UUIDs and the intake validates the
 *   path id against `project.uuid` (hub/src/api/sentry-intake.ts). The official
 *   Sentry SDK REQUIRES an INTEGER project id in the DSN and raises
 *   `BadDsn: Invalid project in DSN` at init — which crash-loops any app the
 *   snippet is installed into. So instead of the SDK we inject a tiny
 *   DEPENDENCY-FREE reporter that:
 *     - reads the DSN from the SENTRY_DSN env var,
 *     - parses `https://<key>@<host>/<uuid>` by hand,
 *     - POSTs a proper Sentry ENVELOPE
 *         {event_id}\n{"type":"event"}\n{event}\n
 *       to  https://<host>/api/sentry/<uuid>/envelope/?sentry_key=<key>
 *       (the exact wire shape hub/src/error-capture/envelope.ts accepts),
 *     - captures unhandled exceptions via the platform's process/excepthook
 *       hook + a fail-open framework middleware,
 *     - is FAIL-OPEN: any reporting error is swallowed; it can NEVER take the
 *       host app down.
 *   Node uses the built-in `node:https`; Python uses the stdlib
 *   `urllib.request`. No third-party dependency is added — so the manifest
 *   patch helpers are now no-ops (kept for call-site compatibility).
 *
 * Proven in finedesignz/mcp-factory PRs #73 (`219c635`) + #74 (`cefae9b`).
 *
 * Each call returns `entry_prepend` (text to insert into the entry file) plus
 * a `manifest_kind` tag. All write helpers are idempotent: if the reporter is
 * already present, we return `{ alreadyConfigured: true }` unchanged.
 */

import type { Stack } from './detect.ts'

export interface SnippetPlan {
  entry_prepend: string
  manifest_kind: 'package.json' | 'requirements.txt'
}

/**
 * Marker string used for idempotency detection across all stacks. If a file
 * already contains this, the reporter is installed.
 */
export const REPORTER_MARKER = 'Remo error capture'

function nodeSnippet(dsn: string): string {
  // Built-in `node:https` only. Reads SENTRY_DSN at runtime (the literal dsn is
  // a fallback default so the snippet still works if the env var is unset).
  return [
    `// --- ${REPORTER_MARKER} (Sentry-compatible intake) — added automatically ---`,
    `// Dependency-free: the Remo hub uses UUID project ids, which the official`,
    `// @sentry/* SDK refuses to parse (it requires an integer project id and`,
    `// throws at init, crash-looping the app). This tiny reporter POSTs a Sentry`,
    `// envelope to the hub intake and is fully fail-open.`,
    `(function () {`,
    `  try {`,
    `    var https = require('node:https');`,
    `    var url = require('node:url');`,
    `    var crypto = require('node:crypto');`,
    `    var _remoDsn = process.env.SENTRY_DSN || ${JSON.stringify(dsn)};`,
    `    if (!_remoDsn) return;`,
    `    // Parse https://<key>@<host>/<uuid>`,
    `    var _u;`,
    `    try { _u = new url.URL(_remoDsn); } catch (e) { return; }`,
    `    var _key = _u.username;`,
    `    var _host = _u.host;`,
    `    var _projectId = _u.pathname.replace(/^\\/+|\\/+$/g, '');`,
    `    if (!_key || !_host || !_projectId) return;`,
    `    var _report = function (err) {`,
    `      try {`,
    `        var e = (err instanceof Error) ? err : new Error(String(err));`,
    `        var frames = [];`,
    `        var stack = (e.stack || '').split('\\n').slice(1);`,
    `        for (var i = 0; i < stack.length; i++) {`,
    `          var m = stack[i].match(/at\\s+(.*?)\\s+\\(?(.+?):(\\d+):(\\d+)\\)?$/);`,
    `          if (m) frames.push({ function: m[1], filename: m[2], lineno: parseInt(m[3], 10) });`,
    `        }`,
    `        frames.reverse();`,
    `        var eventId = crypto.randomBytes(16).toString('hex');`,
    `        var event = {`,
    `          event_id: eventId,`,
    `          platform: 'node',`,
    `          exception: { values: [{ type: e.name || 'Error', value: e.message || '', stacktrace: { frames: frames } }] },`,
    `        };`,
    `        var envelope = JSON.stringify({ event_id: eventId }) + '\\n' +`,
    `          JSON.stringify({ type: 'event' }) + '\\n' + JSON.stringify(event) + '\\n';`,
    `        var req = https.request(`,
    `          'https://' + _host + '/api/sentry/' + _projectId + '/envelope/?sentry_key=' + _key,`,
    `          { method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope' }, timeout: 5000 },`,
    `          function (res) { res.resume(); }`,
    `        );`,
    `        req.on('error', function () {}); // fail-open`,
    `        req.on('timeout', function () { req.destroy(); });`,
    `        req.end(envelope);`,
    `      } catch (e2) { /* fail-open — never crash the app */ }`,
    `    };`,
    `    process.on('uncaughtException', function (err) { _report(err); });`,
    `    process.on('unhandledRejection', function (reason) { _report(reason); });`,
    `  } catch (e) { /* fail-open */ }`,
    `})();`,
    `// --- end ${REPORTER_MARKER} ---`,
    '',
  ].join('\n')
}

function pythonSnippet(dsn: string, framework: 'fastapi' | 'django'): string {
  const lines: string[] = [
    `# --- ${REPORTER_MARKER} (Sentry-compatible intake) — added automatically ---`,
    `# Dependency-free: the Remo hub uses UUID project ids, which the official`,
    `# sentry_sdk refuses to parse (it requires an integer project id and raises`,
    `# BadDsn at init, crash-looping the app). This tiny reporter POSTs a Sentry`,
    `# envelope via the stdlib and is fully fail-open.`,
    `import os as _remo_os`,
    `import sys as _remo_sys`,
    `import json as _remo_json`,
    `import uuid as _remo_uuid`,
    `import traceback as _remo_traceback`,
    `import logging as _remo_logging`,
    `import urllib.request as _remo_urllib`,
    ``,
    `_remo_log = _remo_logging.getLogger("remo.error_capture")`,
    `_REMO_DSN = _remo_os.environ.get("SENTRY_DSN") or ${JSON.stringify(dsn)}`,
    ``,
    ``,
    `def _remo_parse_dsn(dsn):`,
    `    # https://<key>@<host>/<uuid>`,
    `    try:`,
    `        rest = dsn.split("://", 1)[1]`,
    `        key, hostpath = rest.split("@", 1)`,
    `        host, project_id = hostpath.rstrip("/").rsplit("/", 1)`,
    `        if not key or not host or not project_id:`,
    `            return None`,
    `        return key, host, project_id`,
    `    except Exception:`,
    `        return None`,
    ``,
    ``,
    `_REMO_PARSED = _remo_parse_dsn(_REMO_DSN) if _REMO_DSN else None`,
    ``,
    ``,
    `def _remo_report(exc):`,
    `    if not _REMO_PARSED:`,
    `        return`,
    `    try:`,
    `        key, host, project_id = _REMO_PARSED`,
    `        frames = []`,
    `        for fr in _remo_traceback.extract_tb(exc.__traceback__):`,
    `            frames.append({`,
    `                "filename": fr.filename,`,
    `                "function": fr.name,`,
    `                "lineno": fr.lineno,`,
    `                "context_line": fr.line or "",`,
    `            })`,
    `        event_id = _remo_uuid.uuid4().hex`,
    `        event = {`,
    `            "event_id": event_id,`,
    `            "platform": "python",`,
    `            "exception": {`,
    `                "values": [{`,
    `                    "type": type(exc).__name__,`,
    `                    "value": str(exc),`,
    `                    "stacktrace": {"frames": frames},`,
    `                }]`,
    `            },`,
    `        }`,
    `        # The hub expects a Sentry envelope (identity-encoded, newline`,
    `        # delimited): {envelope_header}\\n{item_header type:"event"}\\n{event}`,
    `        envelope = (`,
    `            _remo_json.dumps({"event_id": event_id})`,
    `            + "\\n"`,
    `            + _remo_json.dumps({"type": "event"})`,
    `            + "\\n"`,
    `            + _remo_json.dumps(event)`,
    `            + "\\n"`,
    `        ).encode("utf-8")`,
    `        url = "https://%s/api/sentry/%s/envelope/?sentry_key=%s" % (host, project_id, key)`,
    `        req = _remo_urllib.Request(`,
    `            url,`,
    `            data=envelope,`,
    `            headers={"content-type": "application/x-sentry-envelope"},`,
    `            method="POST",`,
    `        )`,
    `        _remo_urllib.urlopen(req, timeout=5.0).close()`,
    `    except Exception as report_err:  # fail-open — never crash the app`,
    `        _remo_log.warning("remo error-capture report failed: %s", report_err)`,
    ``,
    ``,
    `if _REMO_PARSED:`,
    `    _remo_prev_excepthook = _remo_sys.excepthook`,
    ``,
    `    def _remo_excepthook(exc_type, exc_value, exc_tb):`,
    `        _remo_report(exc_value)`,
    `        _remo_prev_excepthook(exc_type, exc_value, exc_tb)`,
    ``,
    `    _remo_sys.excepthook = _remo_excepthook`,
    `    _remo_log.info("Remo error-capture armed (project %s)", _REMO_PARSED[2])`,
  ]

  if (framework === 'fastapi') {
    lines.push(
      ``,
      `    # Fail-open ASGI middleware: report unhandled request exceptions, then`,
      `    # re-raise so the framework's normal 500 handling is unchanged.`,
      `    try:`,
      `        async def _remo_asgi_factory(app):`,
      `            async def _remo_asgi(scope, receive, send):`,
      `                try:`,
      `                    await app(scope, receive, send)`,
      `                except Exception as exc:  # noqa: BLE001`,
      `                    _remo_report(exc)`,
      `                    raise`,
      `            return _remo_asgi`,
      `        # Best-effort wrap of a module-level FastAPI/Starlette app if present.`,
      `        _remo_app = globals().get("app")`,
      `        if _remo_app is not None and hasattr(_remo_app, "add_middleware"):`,
      `            from starlette.middleware.base import BaseHTTPMiddleware as _RemoBaseMW`,
      ``,
      `            class _RemoCaptureMiddleware(_RemoBaseMW):`,
      `                async def dispatch(self, request, call_next):`,
      `                    try:`,
      `                        return await call_next(request)`,
      `                    except Exception as exc:  # noqa: BLE001`,
      `                        _remo_report(exc)`,
      `                        raise`,
      ``,
      `            _remo_app.add_middleware(_RemoCaptureMiddleware)`,
      `    except Exception:  # fail-open`,
      `        pass`,
    )
  } else {
    lines.push(
      ``,
      `    # Django: the excepthook above covers process-level crashes. Request`,
      `    # exceptions are additionally caught fail-open via the got_request_exception`,
      `    # signal if Django is importable.`,
      `    try:`,
      `        from django.core.signals import got_request_exception as _remo_grx`,
      ``,
      `        def _remo_on_request_exception(sender, **kwargs):`,
      `            try:`,
      `                _remo_report(_remo_sys.exc_info()[1])`,
      `            except Exception:`,
      `                pass`,
      ``,
      `        _remo_grx.connect(_remo_on_request_exception, weak=False)`,
      `    except Exception:  # fail-open (Django not importable at this point)`,
      `        pass`,
    )
  }

  lines.push(`# --- end ${REPORTER_MARKER} ---`, '')
  return lines.join('\n')
}

export function getSnippet(stack: Stack, dsn: string): SnippetPlan {
  switch (stack) {
    case 'node-express':
    case 'node-nextjs':
      return {
        entry_prepend: nodeSnippet(dsn),
        manifest_kind: 'package.json',
      }
    case 'python-fastapi':
      return {
        entry_prepend: pythonSnippet(dsn, 'fastapi'),
        manifest_kind: 'requirements.txt',
      }
    case 'python-django':
      return {
        entry_prepend: pythonSnippet(dsn, 'django'),
        manifest_kind: 'requirements.txt',
      }
  }
}

/**
 * Idempotent injection of the reporter snippet into an entry file.
 *
 * Detects an existing reporter by the `Remo error capture` marker. Also treats
 * a legacy official-SDK install (`@sentry/node`, `@sentry/nextjs`, `sentry_sdk`)
 * as "already configured" so we never stack a reporter on top of an old SDK
 * init. Preserves `#!shebang` lines.
 */
export function injectSnippet(
  source: string,
  snippet: string,
): { content: string; alreadyConfigured: boolean } {
  if (
    source.includes(REPORTER_MARKER) ||
    source.includes('@sentry/node') ||
    source.includes('@sentry/nextjs') ||
    source.includes('sentry_sdk')
  ) {
    return { content: source, alreadyConfigured: true }
  }

  if (source.startsWith('#!')) {
    const newlineIdx = source.indexOf('\n')
    if (newlineIdx === -1) {
      return { content: source + '\n' + snippet, alreadyConfigured: false }
    }
    const shebang = source.slice(0, newlineIdx + 1)
    const rest = source.slice(newlineIdx + 1)
    return { content: shebang + snippet + rest, alreadyConfigured: false }
  }

  return { content: snippet + source, alreadyConfigured: false }
}

/**
 * No-op (kept for call-site compatibility in error-setup.ts).
 *
 * The dependency-free reporter needs NO third-party package, so we never add
 * `@sentry/*` to package.json. Reports `alreadyConfigured: true` so the caller
 * skips emitting a manifest patch.
 */
export function addSentryDep(
  packageJsonContent: string,
  _stack: Extract<Stack, 'node-express' | 'node-nextjs'>,
): { content: string; alreadyConfigured: boolean } {
  return { content: packageJsonContent, alreadyConfigured: true }
}

/**
 * No-op (kept for call-site compatibility in error-setup.ts).
 *
 * The dependency-free reporter uses only the Python stdlib, so we never add
 * `sentry-sdk` to requirements.txt. Reports `alreadyConfigured: true` so the
 * caller skips emitting a manifest patch.
 */
export function addPythonSentryRequirement(
  requirementsTxt: string,
): { content: string; alreadyConfigured: boolean } {
  return { content: requirementsTxt, alreadyConfigured: true }
}
