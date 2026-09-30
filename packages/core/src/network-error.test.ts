import { describe, expect, it } from "vitest";
import { errorDetail, isTransientNetworkError } from "./network-error.js";

const fetchFailed = (code: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`read ${code}`), { code }),
  });

describe("errorDetail", () => {
  it("shows the cause behind Node's bare 'fetch failed'", () => {
    expect(errorDetail(fetchFailed("ECONNRESET"))).toBe(
      "fetch failed (ECONNRESET: read ECONNRESET)",
    );
  });

  it("keeps a plain error as its message, and copes with non-errors", () => {
    expect(errorDetail(new Error("policy: blocked"))).toBe("policy: blocked");
    expect(errorDetail("boom")).toBe("boom");
    expect(errorDetail(undefined)).toBe("undefined");
  });
});

describe("isTransientNetworkError", () => {
  it("is true for network failures, found in the message or in the cause", () => {
    expect(isTransientNetworkError(fetchFailed("ENOTFOUND"))).toBe(true);
    expect(isTransientNetworkError(new Error("request timed out"))).toBe(true);
    expect(isTransientNetworkError(new Error("wrapped", { cause: new Error("ETIMEDOUT") }))).toBe(
      true,
    );
  });

  it("is false for refusals and program errors", () => {
    expect(isTransientNetworkError(new Error("policy: destination not allowed"))).toBe(false);
    expect(isTransientNetworkError(new Error("custom program error: 0x1"))).toBe(false);
  });
});
