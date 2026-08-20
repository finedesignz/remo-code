// Lifted verbatim from claude-code-self-heal/src/fingerprint.ts.
// SHA-256 fingerprint over (project, type, normalized message, top 3 stack
// frames). Normalization strips timestamps, paths, UUIDs, hex, IPs, line/col
// numbers so the same root-cause error always hashes the same regardless of
// run-time variance.
import { createHash } from 'node:crypto';

export function normalize(s: string): string {
  if (!s) return '';
  let out = s;
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, 'TS');
  out = out.replace(/[A-Za-z]:\\(?:[^\s:()]+\\)*[^\s:()]+/g, 'PATH');
  out = out.replace(/\/(?:[^\s:()/]+\/)+[^\s:()/]+/g, 'PATH');
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
  out = out.replace(/0x[0-9a-f]+/gi, 'HEX');
  // Bare hex runs (git SHAs, raw hex request ids) with no 0x prefix. Require
  // length >= 8 AND at least one digit so ordinary hex-letter English words
  // ("decade", "facade", "added") are never collapsed.
  out = out.replace(/\b[0-9a-f]{8,}\b/gi, (m) => (/\d/.test(m) ? 'HEX' : m));
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'IP');
  out = out.replace(/:\d+:\d+/g, ':N:N');
  out = out.replace(/\b\d+:\d+\b/g, 'N:N');
  out = out.replace(/:\d+\b/g, ':N');
  return out;
}

function topFrames(stack: string | undefined, n: number): string {
  if (!stack) return '';
  return stack.split('\n').slice(0, n).map(normalize).join('\n');
}

export function fingerprint(project: string, type: string, message: string, stack?: string): string {
  const h = createHash('sha256');
  h.update(project); h.update('\n');
  h.update(type); h.update('\n');
  h.update(normalize(message)); h.update('\n');
  h.update(topFrames(stack, 3));
  return h.digest('hex');
}
