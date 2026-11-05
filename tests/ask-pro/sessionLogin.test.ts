import { describe, expect, test } from "vitest";
import { parseSessionCookies } from "../../src/ask-pro/sessionLogin.js";

const base = "__Secure-next-auth.session-token";
const expires = Date.now() / 1000 + 3600;
const row = (name = base, value = "fake-not-a-session") => ({ name, value, expires });

describe("session import boundary", () => {
  test("accepts complete chunks out of order and preserves their values and expiry", () => {
    const result = parseSessionCookies(
      JSON.stringify([row(base + ".1", "second"), { ...row(base + ".0", "first"), ignored: true }]),
    );
    expect(result.map(({ name, value, expires: expiry }) => [name, value, expiry])).toEqual([
      [base + ".1", "second", expires],
      [base + ".0", "first", expires],
    ]);
    expect(
      parseSessionCookies(JSON.stringify([{ ...row(), expires: "2099-01-01T00:00:00Z" }]))[0]
        ?.expires,
    ).toBe(4070908800);
  });

  test.each([
    "not json SECRET",
    "[]",
    JSON.stringify([row("cf_clearance")]),
    JSON.stringify([row(base + ".1")]),
    JSON.stringify([row(), row(base + ".0")]),
    JSON.stringify([row(), row()]),
    JSON.stringify([{ ...row(), expires: 1 }]),
    JSON.stringify([{ name: base, value: "SECRET" }]),
    JSON.stringify([row(base, "bad;SECRET")]),
    JSON.stringify([row(base + ".00")]),
  ])("rejects unusable input without disclosing it: case %#", (input) => {
    expect(() => parseSessionCookies(input)).toThrow("Expected a JSON array");
    try {
      parseSessionCookies(input);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
    }
  });
});
