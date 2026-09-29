import { describe, expect, it } from "vitest";
import { toBaseUnits, toUiAmount } from "./tokens.js";

describe("toBaseUnits", () => {
  it("converts without float drift and rounds to the token's precision", () => {
    expect(toBaseUnits(3, 6)).toBe(3_000_000n);
    expect(toBaseUnits(0.1 + 0.2, 6)).toBe(300_000n);
    expect(toBaseUnits(1.23456789, 6)).toBe(1_234_568n);
    expect(toBaseUnits(0.025, 9)).toBe(25_000_000n);
    expect(toUiAmount(toBaseUnits(12.5, 6), 6)).toBe(12.5);
  });
});
