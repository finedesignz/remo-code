import { describe, expect, test } from "bun:test";
import { escapeMarkdownV2, splitForTelegram } from "../src/telegram/client";

describe("escapeMarkdownV2", () => {
  test("escapes all reserved characters", () => {
    const r = escapeMarkdownV2("_*[]()~`>#+-=|{}.!\\");
    // Every reserved char must be prefixed with a single backslash.
    expect(r).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
  });

  test("leaves plain alphanumerics + spaces alone", () => {
    expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
  });

  test("idempotency: escaping twice double-escapes (caller should escape once)", () => {
    const once = escapeMarkdownV2("a.b");
    expect(once).toBe("a\\.b");
    const twice = escapeMarkdownV2(once);
    expect(twice).toBe("a\\\\\\.b");
  });

  test("multi-byte unicode passes through unchanged", () => {
    expect(escapeMarkdownV2("✨🚀café")).toBe("✨🚀café");
  });
});

describe("splitForTelegram", () => {
  test("returns [] for empty string", () => {
    expect(splitForTelegram("")).toEqual([]);
  });

  test("short strings return single chunk", () => {
    expect(splitForTelegram("hi")).toEqual(["hi"]);
  });

  test("exact-4096 stays as one chunk", () => {
    const s = "x".repeat(4096);
    const chunks = splitForTelegram(s);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe(4096);
  });

  test("exact-4097 splits into two chunks", () => {
    const s = "x".repeat(4097);
    const chunks = splitForTelegram(s);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length + chunks[1]!.length).toBe(4097);
    expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
  });

  test("6000-char text splits into 2 chunks at a paragraph boundary when present", () => {
    // 3900 chars then a \n\n at ~3950 then more chars => prefer break at boundary.
    const a = "a".repeat(3900);
    const b = "b".repeat(2100);
    const chunks = splitForTelegram(a + "\n\n" + b);
    expect(chunks).toHaveLength(2);
    // First chunk should END at the paragraph break (i.e. ends with \n\n).
    expect(chunks[0]!.endsWith("\n\n")).toBe(true);
    // Concatenation is loss-less.
    expect(chunks.join("")).toBe(a + "\n\n" + b);
  });

  test("hard-splits when no whitespace exists in the prefer-break window", () => {
    const s = "x".repeat(10_000);
    const chunks = splitForTelegram(s);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("")).toBe(s);
  });

  test("multi-byte input does not exceed 4096 code units per chunk", () => {
    // Each emoji is 2 UTF-16 code units. JS .length === code-unit count.
    const s = "🚀".repeat(3000); // 6000 code units
    const chunks = splitForTelegram(s);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("")).toBe(s);
  });

  test("respects a custom maxLen", () => {
    const chunks = splitForTelegram("a b c d e", 3);
    // Should split at a space within the prefer-break window.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3);
    expect(chunks.join("")).toBe("a b c d e");
  });
});
