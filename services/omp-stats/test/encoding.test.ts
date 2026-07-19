import { describe, expect, test } from "bun:test";

import { decodeThreadKey, encodeThreadKey } from "../src/encoding.ts";

describe("encodeThreadKey", () => {
  test("keeps unreserved bytes verbatim", () => {
    const raw = "AZaz09.-_~";
    expect(encodeThreadKey(raw)).toBe(raw);
  });

  test("percent-encodes everything else with uppercase hex", () => {
    expect(encodeThreadKey("T:1234")).toBe("T%3A1234");
    expect(encodeThreadKey("a b/c")).toBe("a%20b%2Fc");
    expect(encodeThreadKey("%")).toBe("%25");
  });

  test("encodes multi-byte UTF-8 per byte", () => {
    expect(encodeThreadKey("é")).toBe("%C3%A9");
    expect(encodeThreadKey("日")).toBe("%E6%97%A5");
  });
});

describe("decodeThreadKey", () => {
  test("round-trips arbitrary keys", () => {
    for (const raw of ["T:1234", "slack:C042/17123.456", "键 value~", "plain", "%%%"]) {
      expect(decodeThreadKey(encodeThreadKey(raw))).toBe(raw);
    }
  });

  test("accepts lowercase hex escapes", () => {
    expect(decodeThreadKey("T%3a1234")).toBe("T:1234");
  });

  test("rejects malformed escapes", () => {
    expect(() => decodeThreadKey("%G1")).toThrow();
    expect(() => decodeThreadKey("%2")).toThrow();
  });

  test("rejects raw non-ASCII in encoded input", () => {
    expect(() => decodeThreadKey("é")).toThrow();
  });
});
