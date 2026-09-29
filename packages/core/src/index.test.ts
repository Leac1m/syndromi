import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("core package loads", () => {
  expect(PACKAGE_NAME).toBe("@syndromi/core");
});
