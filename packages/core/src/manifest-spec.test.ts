import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { MANIFEST_SPEC_PATH, manifestSpec } from "./manifest-spec.js";

it("docs/manifest-spec.md matches the schema (run pnpm docs:manifest)", async () => {
  expect(await readFile(MANIFEST_SPEC_PATH, "utf8")).toBe(manifestSpec());
});

it("the spec's example is a valid manifest", () => {
  const yaml = manifestSpec().split("```yaml\n")[1]?.split("```")[0] ?? "";
  expect(parseManifest(yaml)).toMatchObject({ ok: true });
});
