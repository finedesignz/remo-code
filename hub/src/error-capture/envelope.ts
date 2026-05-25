// Lifted verbatim from claude-code-self-heal/src/sentry/envelope.ts.
// Parses Sentry's gzipped multi-line JSON envelope format:
//   { envelope_header }\n
//   { item_header_1 }\n{ item_payload_1 }\n
//   { item_header_2 }\n{ item_payload_2 }\n...
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

export interface EnvelopeHeader { event_id?: string; sent_at?: string; [k: string]: unknown; }
export interface EnvelopeItem { header: { type: string; length?: number; [k: string]: unknown }; payload: unknown; }
export interface ParsedEnvelope { header: EnvelopeHeader; items: EnvelopeItem[]; }

export async function parseEnvelope(body: Buffer, headers: Record<string, string | undefined>): Promise<ParsedEnvelope> {
  const enc = (headers['content-encoding'] ?? '').toLowerCase();
  const raw = enc === 'gzip' ? await gunzipAsync(body) : body;
  const lines = raw.toString('utf8').split('\n').filter(l => l.length > 0);
  if (lines.length === 0) throw new Error('empty envelope');
  const header = JSON.parse(lines[0]) as EnvelopeHeader;
  const items: EnvelopeItem[] = [];
  let i = 1;
  while (i < lines.length) {
    const itemHeader = JSON.parse(lines[i]) as EnvelopeItem['header'];
    i++;
    if (i >= lines.length) break;
    items.push({ header: itemHeader, payload: JSON.parse(lines[i]) });
    i++;
  }
  return { header, items };
}
