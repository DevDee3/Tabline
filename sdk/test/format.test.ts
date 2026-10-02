import { describe, expect, it } from "vitest";
import { formatDuration, formatUsdc, parseUsdc } from "../src/format";

describe("formatUsdc", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatUsdc(10_000_000n)).toBe("10.00");
    expect(formatUsdc("1500000")).toBe("1.50");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1_234_567_890_000n)).toBe("1,234,567.89");
  });
  it("handles negative and zero", () => {
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(-5_000_000n)).toBe("-5.00");
  });
});

describe("parseUsdc", () => {
  it("round-trips with formatUsdc at 6 decimals", () => {
    expect(parseUsdc("10")).toBe(10_000_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("1234.5")).toBe(1_234_500_000n);
  });
  it("rejects garbage input", () => {
    expect(() => parseUsdc("abc")).toThrow();
    expect(() => parseUsdc("1.2345678")).toThrow();
    expect(() => parseUsdc("-1")).toThrow();
  });
});

describe("formatDuration", () => {
  it("picks the largest clean unit", () => {
    expect(formatDuration(30 * 86400)).toBe("month");
    expect(formatDuration(60 * 86400)).toBe("2 months");
    expect(formatDuration(7 * 86400)).toBe("week");
    expect(formatDuration(86400)).toBe("day");
    expect(formatDuration(3600)).toBe("hour");
    expect(formatDuration(90)).toBe("90 seconds");
  });
});
