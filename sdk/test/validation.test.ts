import { describe, expect, it } from "vitest";
import { isValidCvc, isValidExpiry, isValidLuhn, parseExpiry } from "../src/validation";

describe("isValidLuhn", () => {
  it("accepts well-known test card numbers", () => {
    expect(isValidLuhn("4242424242424242")).toBe(true);
    expect(isValidLuhn("5555555555554444")).toBe(true);
    expect(isValidLuhn("378282246310005")).toBe(true);
  });

  it("accepts numbers formatted with spaces", () => {
    expect(isValidLuhn("4242 4242 4242 4242")).toBe(true);
  });

  it("rejects a number with a broken checksum", () => {
    expect(isValidLuhn("4242424242424241")).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(isValidLuhn("abcd efgh ijkl mnop")).toBe(false);
  });

  it("rejects too-short or too-long input", () => {
    expect(isValidLuhn("42")).toBe(false);
    expect(isValidLuhn("4".repeat(25))).toBe(false);
  });
});

describe("parseExpiry", () => {
  it("parses MM/YY", () => {
    expect(parseExpiry("09/28")).toEqual({ month: 9, year: 2028 });
  });

  it("parses MM/YYYY", () => {
    expect(parseExpiry("09/2028")).toEqual({ month: 9, year: 2028 });
  });

  it("rejects invalid months", () => {
    expect(parseExpiry("13/28")).toBeNull();
    expect(parseExpiry("00/28")).toBeNull();
  });

  it("rejects malformed strings", () => {
    expect(parseExpiry("hello")).toBeNull();
    expect(parseExpiry("09-28")).toBeNull();
  });
});

describe("isValidExpiry", () => {
  const now = new Date("2026-07-07T00:00:00Z");

  it("accepts a future expiry", () => {
    expect(isValidExpiry("08/26", now)).toBe(true);
    expect(isValidExpiry("12/30", now)).toBe(true);
  });

  it("accepts the current month as not-yet-expired", () => {
    expect(isValidExpiry("07/26", now)).toBe(true);
  });

  it("rejects a past month in the current year", () => {
    expect(isValidExpiry("01/26", now)).toBe(false);
  });

  it("rejects a past year entirely", () => {
    expect(isValidExpiry("12/20", now)).toBe(false);
  });

  it("rejects unreasonably far future dates", () => {
    expect(isValidExpiry("01/60", now)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isValidExpiry("garbage", now)).toBe(false);
  });
});

describe("isValidCvc", () => {
  it("accepts 3-digit CVCs", () => {
    expect(isValidCvc("123")).toBe(true);
  });

  it("accepts 4-digit CVCs (Amex)", () => {
    expect(isValidCvc("1234")).toBe(true);
  });

  it("rejects too-short or too-long codes", () => {
    expect(isValidCvc("12")).toBe(false);
    expect(isValidCvc("12345")).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(isValidCvc("abc")).toBe(false);
  });
});
