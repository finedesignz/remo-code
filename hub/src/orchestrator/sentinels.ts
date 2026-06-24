// hub/src/orchestrator/sentinels.ts
// Milestone TMAC (autonomous task-type macro prompts) — Phase TMAC-01.
//
// Pure parser for the three sentinel blocks the macro-driven agent emits and the
// hub reconciles each tick (SPEC §2.6 / §4 STEP 5):
//
//   <<STATE                         lifecycle position → run-log + resume display
//   lifecycle: building
//   milestone: TMAC
//   phase: 3/6
//   last_action: ...
//   next_action: ...
//   decisions: ...
//   deployed_live: no
//   STATE>>
//
//   <<NOTIFY level=info channel=all detail="shipped v1.2.0, live">>   request a human signal
//   <<GATE reason="destructive migration" detail="needs approval">>    paused on a mandatory gate
//
// STATE uses `key: value` body lines (mirrors the controller's RUNLOG/DECISION
// blocks). NOTIFY and GATE carry their fields as inline `key=value` / `key="..."`
// attributes on the opening tag (per the SPEC §4/§5 literal text), but we ALSO
// accept body `key: value` lines for them so a multiline emission still parses.
//
// SCOPE: PURE — no DB, no network, no clock. A missing/malformed block yields a
// SAFE empty result (the field is `null`), NEVER throws — mirroring the
// `parseControllerDecisions` SAFE_FALLBACK contract so one bad agent turn never
// stalls or writes junk.

// ── Block regexes (mirror controller.ts RUNLOG_RE / DECISION_RE) ─────────────
// `<<TAG ...inline... >>` self-closing OR `<<TAG ...\n body \n TAG>>` paired.
const STATE_RE = /<<STATE\b([\s\S]*?)(?:^|\n)\s*STATE(?:>>)?(?:\s|$)/i;
// Match up to the literal `>>` terminator (not the first `>`), so a `>` inside an
// attribute value — e.g. detail="latency > 500ms" — does not truncate the block.
const NOTIFY_RE = /<<NOTIFY\b([\s\S]*?)>>/gi;
const GATE_RE = /<<GATE\b([\s\S]*?)>>/gi;

export interface StateSentinel {
  lifecycle: string | null;
  milestone: string | null;
  phase: string | null;
  last_action: string | null;
  next_action: string | null;
  decisions: string | null;
  deployed_live: string | null;
}

export type NotifyLevel = 'info' | 'blocking';

export interface NotifySentinel {
  level: NotifyLevel;
  channel: string | null;
  detail: string | null;
}

export interface GateSentinel {
  reason: string | null;
  detail: string | null;
}

export interface ParsedSentinels {
  state: StateSentinel | null;
  notifies: NotifySentinel[];
  gate: GateSentinel | null;
}

const EMPTY: ParsedSentinels = { state: null, notifies: [], gate: null };

function emptyToNull(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
}

/** Parse `key: value` lines from a block body into a lower-cased field map. */
function parseLineFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key) fields[key] = val;
  }
  return fields;
}

/**
 * Parse inline `key=value` / `key="quoted value"` attributes off an opening-tag
 * remainder (e.g. ` level=info channel=all detail="shipped, live"`). Quoted
 * values may contain spaces; bare values run to the next whitespace.
 */
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
function parseInlineAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (s ?? '').matchAll(ATTR_RE)) {
    const key = m[1]?.trim().toLowerCase();
    if (!key) continue;
    out[key] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

/** Merge inline attrs (opening tag) with body `key: value` lines; inline wins. */
function fieldsFor(rawInner: string): Record<string, string> {
  const lineFields = parseLineFields(rawInner);
  const inlineFields = parseInlineAttrs(rawInner.split('\n')[0] ?? '');
  return { ...lineFields, ...inlineFields };
}

function normLevel(v: string | undefined): NotifyLevel {
  return (v ?? '').trim().toLowerCase() === 'blocking' ? 'blocking' : 'info';
}

/**
 * Parse all sentinel blocks from a session reply. SAFE: any block absent →
 * `null`/empty; never throws. At most one STATE and one GATE are recognized
 * (first match); NOTIFY may repeat.
 */
export function parseSentinels(raw: string): ParsedSentinels {
  const text = raw ?? '';
  if (!text) return EMPTY;

  // STATE — paired block with key: value body lines.
  let state: StateSentinel | null = null;
  const sm = text.match(STATE_RE);
  if (sm) {
    const f = parseLineFields(sm[1] ?? '');
    state = {
      lifecycle: emptyToNull(f.lifecycle),
      milestone: emptyToNull(f.milestone),
      phase: emptyToNull(f.phase),
      last_action: emptyToNull(f.last_action),
      next_action: emptyToNull(f.next_action),
      decisions: emptyToNull(f.decisions),
      deployed_live: emptyToNull(f.deployed_live),
    };
  }

  // NOTIFY — zero or more, inline attrs on the opening tag.
  const notifies: NotifySentinel[] = [];
  for (const m of text.matchAll(NOTIFY_RE)) {
    const f = fieldsFor(m[1] ?? '');
    notifies.push({
      level: normLevel(f.level),
      channel: emptyToNull(f.channel),
      detail: emptyToNull(f.detail),
    });
  }

  // GATE — first match wins (a run is halted on the first mandatory gate).
  let gate: GateSentinel | null = null;
  const gm = [...text.matchAll(GATE_RE)][0];
  if (gm) {
    const f = fieldsFor(gm[1] ?? '');
    gate = { reason: emptyToNull(f.reason), detail: emptyToNull(f.detail) };
  }

  return { state, notifies, gate };
}
