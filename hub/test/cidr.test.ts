import { describe, test, expect } from 'bun:test'
import { isValidIpOrCidr, parseAllowlist, ipAllowed, sourceIpFromHeaders } from '../src/lib/cidr.ts'

describe('isValidIpOrCidr', () => {
  test('accepts plain IPv4', () => {
    expect(isValidIpOrCidr('46.224.61.233')).toBe(true)
    expect(isValidIpOrCidr('0.0.0.0')).toBe(true)
    expect(isValidIpOrCidr('255.255.255.255')).toBe(true)
  })
  test('accepts IPv4 CIDR', () => {
    expect(isValidIpOrCidr('10.0.0.0/8')).toBe(true)
    expect(isValidIpOrCidr('192.168.1.0/24')).toBe(true)
    expect(isValidIpOrCidr('0.0.0.0/0')).toBe(true)
  })
  test('accepts IPv6 and CIDR', () => {
    expect(isValidIpOrCidr('::1')).toBe(true)
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true)
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true)
  })
  test('rejects nonsense', () => {
    expect(isValidIpOrCidr('not-an-ip')).toBe(false)
    expect(isValidIpOrCidr('999.999.999.999')).toBe(false)
    expect(isValidIpOrCidr('10.0.0.0/33')).toBe(false)
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false)
    expect(isValidIpOrCidr('')).toBe(false)
  })
})

describe('parseAllowlist', () => {
  test('parses csv, trims, dedups, preserves order', () => {
    expect(parseAllowlist(' 1.2.3.4 ,1.2.3.4, 5.6.7.0/24')).toEqual(['1.2.3.4', '5.6.7.0/24'])
  })
  test('empty / blanks → empty array', () => {
    expect(parseAllowlist('')).toEqual([])
    expect(parseAllowlist(' , , ')).toEqual([])
  })
  test('throws on bad entry', () => {
    expect(() => parseAllowlist('1.2.3.4, not-an-ip')).toThrow(/invalid_cidr_entry/)
  })
})

describe('ipAllowed', () => {
  test('empty allowlist → allow all', () => {
    expect(ipAllowed('1.2.3.4', [])).toBe(true)
    expect(ipAllowed('1.2.3.4', null)).toBe(true)
  })
  test('exact IPv4 match', () => {
    expect(ipAllowed('46.224.61.233', ['46.224.61.233'])).toBe(true)
    expect(ipAllowed('46.224.61.234', ['46.224.61.233'])).toBe(false)
  })
  test('IPv4 CIDR match', () => {
    expect(ipAllowed('10.5.99.42', ['10.0.0.0/8'])).toBe(true)
    expect(ipAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false)
    expect(ipAllowed('192.168.1.5', ['192.168.1.0/24'])).toBe(true)
    expect(ipAllowed('192.168.2.5', ['192.168.1.0/24'])).toBe(false)
  })
  test('IPv6 exact + CIDR', () => {
    expect(ipAllowed('::1', ['::1'])).toBe(true)
    expect(ipAllowed('2001:db8::abcd', ['2001:db8::/32'])).toBe(true)
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false)
  })
  test('null sourceIp + non-empty allowlist → deny', () => {
    expect(ipAllowed(null, ['1.2.3.4'])).toBe(false)
  })
  test('mixed allowlist', () => {
    expect(ipAllowed('46.224.61.233', ['10.0.0.0/8', '46.224.61.233'])).toBe(true)
  })
})

describe('sourceIpFromHeaders', () => {
  const mk = (kv: Record<string, string | null>) => ({
    get: (n: string) => kv[n.toLowerCase()] ?? null,
  })
  test('prefers cf-connecting-ip', () => {
    expect(sourceIpFromHeaders(mk({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toBe('1.1.1.1')
  })
  test('falls back to x-real-ip', () => {
    expect(sourceIpFromHeaders(mk({ 'x-real-ip': '2.2.2.2' }))).toBe('2.2.2.2')
  })
  test('falls back to first x-forwarded-for hop', () => {
    expect(sourceIpFromHeaders(mk({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4' }))).toBe('3.3.3.3')
  })
  test('all missing → null', () => {
    expect(sourceIpFromHeaders(mk({}))).toBe(null)
  })
})
