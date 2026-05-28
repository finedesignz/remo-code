import { describe, expect, test } from "bun:test";
import { __test } from "../src/telegram/link-codes";

const { generateCode, CODE_LEN, LINK_CODE_TTL_MS } = __test;

describe("link-code generator", () => {
  test("produces an 8-char string", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LEN);
    }
  });

  test("uses Crockford base32 alphabet (no I, L, O, U)", () => {
    const alphabet = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
    for (let i = 0; i < 100; i++) {
      const c = generateCode();
      expect(c).toMatch(alphabet);
    }
  });

  test("codes have at least ~40 bits of entropy (no collisions across 200 draws)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateCode());
    expect(seen.size).toBe(200);
  });

  test("TTL is 10 minutes", () => {
    expect(LINK_CODE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
