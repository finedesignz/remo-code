// Lifted verbatim from claude-code-self-heal/src/sentry/auth.ts.
// Parses the `sentry_key=<key>` token out of Sentry's X-Sentry-Auth header
// (which looks like:
//   Sentry sentry_version=7, sentry_client=..., sentry_key=abcdef...
// ). Falls back to ?sentry_key= query param if the header is absent — that
// path exists for legacy SDKs that pass the key in the URL.
export function extractSentryKey(header: string | undefined, queryKey: string | undefined): string | null {
  if (header) {
    const m = header.match(/sentry_key=([^,\s]+)/);
    if (m) return m[1];
  }
  return queryKey ?? null;
}
