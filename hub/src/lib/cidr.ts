/**
 * Tiny CIDR / IP allowlist helper.
 *
 * Supports:
 *   - Plain IPv4:           "46.224.61.233"
 *   - IPv4 CIDR:            "10.0.0.0/8"
 *   - Plain IPv6:           "2001:db8::1"
 *   - IPv6 CIDR:            "2001:db8::/32"
 *
 * No external deps — small, audited surface. Used by the Coolify webhook
 * ingress to enforce the per-user `coolify_webhook_allowed_ips` allowlist.
 */

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  // >>> 0 to keep unsigned.
  return n >>> 0;
}

function parseIpv6(ip: string): bigint | null {
  // Strip optional zone id (fe80::1%eth0).
  const cleaned = ip.split('%')[0];
  // Collapse `::`.
  if (cleaned.indexOf('::') !== cleaned.lastIndexOf('::')) return null;
  let head: string[] = [];
  let tail: string[] = [];
  if (cleaned.includes('::')) {
    const [h, t] = cleaned.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    head = head.concat(Array(missing).fill('0'));
  } else {
    head = cleaned.split(':');
    if (head.length !== 8) return null;
  }
  const all = head.concat(tail);
  if (all.length !== 8) return null;
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function isValidIpOrCidr(entry: string): boolean {
  const e = entry.trim();
  if (!e) return false;
  const slash = e.indexOf('/');
  if (slash === -1) {
    return parseIpv4(e) !== null || parseIpv6(e) !== null;
  }
  const addr = e.slice(0, slash);
  const bitsStr = e.slice(slash + 1);
  if (!/^\d+$/.test(bitsStr)) return false;
  const bits = Number(bitsStr);
  if (parseIpv4(addr) !== null) return bits >= 0 && bits <= 32;
  if (parseIpv6(addr) !== null) return bits >= 0 && bits <= 128;
  return false;
}

/**
 * Parse a comma-separated allowlist string, dropping blanks and validating
 * every entry. Throws Error('invalid_cidr_entry: <entry>') on the first bad one.
 * Returns the cleaned canonical CSV (trimmed, deduped, preserving order).
 */
export function parseAllowlist(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const e = raw.trim();
    if (!e) continue;
    if (!isValidIpOrCidr(e)) {
      throw new Error(`invalid_cidr_entry: ${e}`);
    }
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

function ipv4Match(ip: number, cidrAddr: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ip & mask) === (cidrAddr & mask);
}

function ipv6Match(ip: bigint, cidrAddr: bigint, bits: number): boolean {
  if (bits === 0) return true;
  const shift = 128 - bits;
  const mask = shift === 0 ? (1n << 128n) - 1n : ((1n << 128n) - 1n) ^ ((1n << BigInt(shift)) - 1n);
  return (ip & mask) === (cidrAddr & mask);
}

/**
 * Check whether `sourceIp` falls within any entry of `allowlist`.
 * Empty / null allowlist → returns true (back-compat: allow-all).
 * Unknown / unparseable `sourceIp` → returns false (deny).
 */
export function ipAllowed(sourceIp: string | null | undefined, allowlist: string[] | null | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!sourceIp) return false;
  const ip4 = parseIpv4(sourceIp);
  const ip6 = ip4 === null ? parseIpv6(sourceIp) : null;
  if (ip4 === null && ip6 === null) return false;
  for (const entry of allowlist) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      // Exact match.
      if (ip4 !== null && parseIpv4(entry) === ip4) return true;
      if (ip6 !== null) {
        const e6 = parseIpv6(entry);
        if (e6 !== null && e6 === ip6) return true;
      }
      continue;
    }
    const addr = entry.slice(0, slash);
    const bits = Number(entry.slice(slash + 1));
    if (ip4 !== null) {
      const cidrAddr = parseIpv4(addr);
      if (cidrAddr !== null && ipv4Match(ip4, cidrAddr, bits)) return true;
    }
    if (ip6 !== null) {
      const cidrAddr = parseIpv6(addr);
      if (cidrAddr !== null && ipv6Match(ip6, cidrAddr, bits)) return true;
    }
  }
  return false;
}

/**
 * Extract the source IP from a Hono request — matches the order the rest of
 * the hub uses (cf-connecting-ip → x-real-ip → first x-forwarded-for hop).
 */
export function sourceIpFromHeaders(headers: {
  get(name: string): string | null | undefined;
}): string | null {
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}
