import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { ruleCard } from "./rule-card.js";

const manifest = (name: string) => {
  const text = readFileSync(
    fileURLToPath(new URL(`../../../templates/${name}/manifest.yaml`, import.meta.url)),
    "utf8",
  );
  const parsed = parseManifest(text);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.manifest;
};

describe("ruleCard", () => {
  it("states the yield-scout budget and rules in plain language", () => {
    expect(ruleCard(manifest("yield-scout"))).toEqual([
      "yield-scout may take up to 50 USDC per week from your bag. The limit is enforced onchain.",
      "It may only use Jupiter swaps and pulling its allowance, and funds may only go to its own wallet.",
      "No single transaction may move more than $25; anything above $10 waits for your signature.",
      "You send it 0.02 SOL once for network fees.",
      "It runs hosted by syndromi, which holds its key.",
      "You can revoke it at any time with the kill switch.",
    ]);
  });

  it("says who drives an external agent", () => {
    const card = ruleCard(manifest("mcp-agent"));
    expect(card[0]).toBe(
      "mcp-agent may take up to 5 USDC per week from your bag. The limit is enforced onchain.",
    );
    expect(card.at(-2)).toMatch(/^An outside agent \(an MCP client such as Claude\) decides/);
  });

  it("describes local agents and explicit destinations", () => {
    const m = manifest("dca-agent");
    const card = ruleCard({
      ...m,
      permissions: {
        ...m.permissions,
        destinations: ["self", address("J7y26W7aHyfS1pf1WmkoRZayRw8EyGhwGpPHmKGoeXFH")],
      },
    });
    expect(card[0]).toMatch(/^dca-agent may take up to 20 USDC per week/);
    expect(card[1]).toMatch(/its own wallet and J7y2…eXFH\.$/);
    expect(card).toContain("It runs on your machine, with its key encrypted there.");
  });
});
