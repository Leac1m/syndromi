import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest, periodSeconds, toPolicy } from "./manifest.js";

const template = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../templates/${name}/manifest.yaml`, import.meta.url)),
    "utf8",
  );

const valid = `
name: yield-scout
runtime: hosted
model: byok:anthropic
schedule: "*/15 * * * *"
allowance: { mint: USDC, amount: 50, period: weekly }
fee_budget: { sol: 0.02 }
permissions:
  programs: [jupiter]
  destinations: [self]
  max_tx_usd: 25
  approve_above_usd: 10
tools: [pyth-price, jupiter-quote, jupiter-swap, balances, pull-allowance, request-topup]
prompt: ./prompt.md
`;

const errorsFor = (yaml: string) => {
  const result = parseManifest(yaml, "yield-scout/manifest.yaml");
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};

describe("parseManifest", () => {
  it.each(["dca-agent", "yield-scout"])("accepts the %s template", (name) => {
    const result = parseManifest(template(name), `${name}/manifest.yaml`);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("accepts the CLAUDE.md example shape and maps it to a policy", () => {
    const result = parseManifest(valid);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(toPolicy(result.manifest)).toEqual({
      programs: ["jupiter"],
      destinations: ["self"],
      maxTxUsd: 25,
      approveAboveUsd: 10,
    });
    expect(periodSeconds(result.manifest.allowance.period)).toBe(604_800);
  });

  it("explains an approval threshold above the cap", () => {
    expect(errorsFor(valid.replace("approve_above_usd: 10", "approve_above_usd: 30"))).toEqual([
      "yield-scout/manifest.yaml: permissions.approve_above_usd (30) must not exceed max_tx_usd (25)",
    ]);
  });

  it("reports every problem, one per line, with the field path", () => {
    const broken = valid
      .replace("name: yield-scout", "name: Yield Scout")
      .replace("amount: 50", "amount: -5")
      .replace("period: weekly", "period: hourly")
      .replace("programs: [jupiter]", "programs: [jupiter, raydium]")
      .replace("destinations: [self]", "destinations: [someone]")
      .replace('schedule: "*/15 * * * *"', 'schedule: "every 15 minutes"');
    const errors = errorsFor(broken);
    const text = errors.join("\n");
    expect(text).toMatch(/name must be kebab-case/);
    expect(text).toMatch(/allowance\.amount must be greater than 0/);
    expect(text).toMatch(
      /allowance\.period invalid option: expected one of "daily"\|"weekly"\|"monthly"/,
    );
    expect(text).toMatch(/permissions\.programs\.1 /);
    expect(text).toMatch(/permissions\.destinations\.0 must be "self" or a Solana address/);
    expect(text).toMatch(/schedule must be a 5-field cron expression/);
    for (const line of errors) expect(line.startsWith("yield-scout/manifest.yaml: ")).toBe(true);
  });

  it("rejects unknown keys and bad YAML", () => {
    expect(errorsFor(`${valid}\nsecret_mode: true\n`).join("\n")).toMatch(/secret_mode/);
    expect(errorsFor("name: [unclosed")[0]).toMatch(/invalid YAML/);
  });

  it("only accepts known model providers", () => {
    expect(errorsFor(valid.replace("byok:anthropic", "gpt-4")).join("\n")).toMatch(
      /model must be "byok:anthropic" or "openai-compatible:<https url>"/,
    );
  });

  it("needs a model_id for openai-compatible models, and api_key_env must name a variable", () => {
    const openai = valid.replace("byok:anthropic", "openai-compatible:https://example.com/v1");
    expect(errorsFor(openai).join("\n")).toMatch(/model_id is required for openai-compatible/);
    expect(parseManifest(`${openai}\nmodel_id: some-model\n`).ok).toBe(true);
    expect(errorsFor(`${valid}\napi_key_env: sk-live-123\n`).join("\n")).toMatch(
      /api_key_env must be an env var name/,
    );
  });

  it("accepts only the known demo switches", () => {
    expect(
      parseManifest(`${valid}\ndemo: { injection: true, unguarded: true, script: injection }\n`).ok,
    ).toBe(true);
    expect(errorsFor(`${valid}\ndemo: { skip_policy: true }\n`).join("\n")).toMatch(/skip_policy/);
  });
});
