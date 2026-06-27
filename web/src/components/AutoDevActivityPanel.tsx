/**
 * web/src/components/AutoDevActivityPanel.tsx
 * OBSRV-02 / RUNLOG-03 + RUNLOG-04 — Auto-Dev Activity timeline panel.
 *
 * Two modes:
 *   sessionId provided → per-session view (newest-first, labelled rationale→command→outcome→PR→verdict→deploy)
 *   sessionId absent   → hub-wide feed across all user sessions (same layout + session/repo label per row)
 *
 * Consumes GET /api/orchestrator/run-log (read-only; zero dispatch-path changes).
 * Accent = blue only; orange is CTA-only. No purple-adjacent hues.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hubFetch } from '../lib/api';
import type { RunLogEntry } from '../lib/run-log-api';
import { fetchRunLog } from '../lib/run-log-api';

const PAGE_SIZE = 30;

// ── small helpers ────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function shortRepo(repoKey: string | null): string {
  if (!repoKey) return '';
  // github://owner/repo → owner/repo
  return repoKey.replace(/^github:\/\//, '').replace(/^path:\/\/.*\/([^/]+)$/, '$1');
}

// Badge pill — outcome / verdict status
function StatusBadge({ text }: { text: string }) {
  const t = text.toLowerCase();
  let cls = 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]';
  if (/pass|success|merged|green/.test(t)) cls = 'bg-emerald-500/15 text-emerald-400';
  else if (/fail|error|red/.test(t)) cls = 'bg-red-500/15 text-red-400';
  else if (/partial|warn|amber|yellow/.test(t)) cls = 'bg-amber-500/15 text-amber-400';
  else if (/skip|no_session|idle/.test(t)) cls = 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]';
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-mono leading-none ${cls}`}>
      {text}
    </span>
  );
}

// ── single run-log row ────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: RunLogEntry;
  showSession?: boolean;
}

function EntryRow({ entry, showSession }: EntryRowProps) {
  const [expanded, setExpanded] = useState(false);

  const hasDetail =
    entry.decision_rationale ||
    entry.gap_dimension ||
    entry.reviewer_verdict ||
    entry.deploy_verify_result;

  return (
    <li className="border-b border-[var(--border-color)] last:border-0 py-3 px-4">
      {/* top line: timestamp + repo (hub-wide mode) + command */}
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] text-[var(--text-muted)] shrink-0 pt-0.5 tabular-nums">
          {relTime(entry.created_at)}
        </span>

        {showSession && entry.repo_key && (
          <span className="text-[11px] rounded bg-blue-600/15 text-blue-400 px-1.5 py-0.5 shrink-0 font-mono leading-none">
            {shortRepo(entry.repo_key)}
          </span>
        )}

        <code className="text-xs text-[var(--text-primary)] font-mono break-all flex-1 min-w-0">
          {entry.command}
        </code>

        {hasDetail && (
          <button
            onClick={() => setExpanded((x) => !x)}
            className="shrink-0 text-[11px] text-blue-400 hover:text-blue-300 ml-auto"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>

      {/* outcome on same line if short */}
      {entry.outcome && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">outcome</span>
          <StatusBadge text={entry.outcome} />
          {entry.pr_url && (
            <a
              href={entry.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-blue-400 hover:text-blue-300 underline truncate max-w-[260px]"
            >
              {entry.pr_url.replace('https://github.com/', '')}
            </a>
          )}
        </div>
      )}

      {/* expanded detail */}
      {expanded && hasDetail && (
        <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-blue-600/30">
          {entry.decision_rationale && (
            <Detail label="rationale" text={entry.decision_rationale} />
          )}
          {entry.gap_dimension && (
            <Detail label="gap" text={entry.gap_dimension} />
          )}
          {entry.reviewer_verdict && (
            <Detail label="reviewer" text={entry.reviewer_verdict} />
          )}
          {entry.deploy_verify_result && (
            <Detail label="deploy-verify" text={entry.deploy_verify_result} />
          )}
        </div>
      )}
    </li>
  );
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="text-[var(--text-muted)] shrink-0 w-24">{label}</span>
      <span className="text-[var(--text-secondary)] break-words min-w-0">{text}</span>
    </div>
  );
}

// ── main panel ───────────────────────────────────────────────────────────────

export interface AutoDevActivityPanelProps {
  token: string | null;
  /** When provided → per-session view. Omit → hub-wide feed. */
  sessionId?: string;
  /** Optional heading override */
  title?: string;
}

export function AutoDevActivityPanel({
  token,
  sessionId,
  title,
}: AutoDevActivityPanelProps) {
  const [entries, setEntries] = useState<RunLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      try {
        const page = await fetchRunLog({ token, sessionId, limit: PAGE_SIZE, offset });
        setEntries((prev) => (append ? [...prev, ...page.entries] : page.entries));
        setHasMore(page.hasMore);
        offsetRef.current = offset + page.entries.length;
        setError(null);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load run log');
      }
    },
    [token, sessionId],
  );

  useEffect(() => {
    setLoading(true);
    setEntries([]);
    offsetRef.current = 0;
    load(0, false).finally(() => setLoading(false));
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    await load(offsetRef.current, true);
    setLoadingMore(false);
  };

  const heading = title ?? (sessionId ? 'Auto-Dev Activity' : 'Orchestrator Run Feed');
  const isGlobal = !sessionId;

  return (
    <section
      aria-label={heading}
      className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden"
    >
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{heading}</h3>
        {isGlobal && (
          <span className="text-[11px] text-[var(--text-muted)]">all sessions</span>
        )}
      </div>

      {/* body */}
      {loading ? (
        <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          Loading…
        </div>
      ) : error ? (
        <div className="px-4 py-6 text-center text-sm text-red-400">{error}</div>
      ) : entries.length === 0 ? (
        <EmptyState sessionId={sessionId} />
      ) : (
        <>
          <ul className="divide-y-0">
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} showSession={isGlobal} />
            ))}
          </ul>

          {hasMore && (
            <div className="px-4 py-3 border-t border-[var(--border-color)]">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EmptyState({ sessionId }: { sessionId?: string }) {
  return (
    <div className="px-4 py-10 text-center space-y-1">
      <p className="text-sm text-[var(--text-muted)]">No auto-dev runs yet</p>
      <p className="text-[11px] text-[var(--text-muted)]">
        {sessionId
          ? 'The orchestrator has not run any cycles for this session.'
          : 'Enable the orchestrator on a session to start autonomous development.'}
      </p>
    </div>
  );
}
