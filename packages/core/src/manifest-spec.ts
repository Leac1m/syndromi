// Generates docs/manifest-spec.md from manifestSchema, so the spec is the code. A test fails when
// the file is stale; `pnpm docs:manifest` rewrites it.
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { manifestSchema, PERIODS, TOOL_NAMES } from "./manifest.js";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  description?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

const code = (v: unknown) => `\`${String(v)}\``;

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map(code).join(" \\| ");
  if (s.const !== undefined) return code(s.const);
  if (s.anyOf) return s.anyOf.map(typeOf).join(" or ");
  if (s.type === "array" && s.items) return `list of ${typeOf(s.items)}`;
  return s.type ?? "any";
}

function rulesOf(s: JsonSchema): string {
  const rules: string[] = [];
  if (s.exclusiveMinimum !== undefined) rules.push(`> ${s.exclusiveMinimum}`);
  if (s.minimum !== undefined) rules.push(`≥ ${s.minimum}`);
  if (s.maximum !== undefined) rules.push(`≤ ${s.maximum}`);
  if (s.minItems) rules.push(`at least ${s.minItems}`);
  if (s.pattern) rules.push(`matches ${code(s.pattern)}`);
  return rules.join(", ");
}

function rows(schema: JsonSchema, prefix = "", parentRequired = true): string[] {
  const out: string[] = [];
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${key}`;
    const required = parentRequired && (schema.required ?? []).includes(key);
    const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
    out.push(
      `| ${code(path)} | ${field.properties ? "object" : typeOf(field)} | ${required ? "yes" : "no"} | ${cell(rulesOf(field))} | ${cell(field.description ?? "")} |`,
    );
    if (field.properties) out.push(...rows(field, `${path}.`, required));
  }
  return out;
}

export function manifestSpec(): string {
  const schema = z.toJSONSchema(manifestSchema, { unrepresentable: "any" }) as JsonSchema;
  return `# Manifest spec

<!-- Generated from packages/core/src/manifest.ts by \`pnpm docs:manifest\`. Do not edit by hand. -->

An agent is a directory with a \`manifest.yaml\` and a prompt file. The same directory runs locally
(\`syndromi run <dir>\`) or hosted (\`syndromi deploy <dir>\`). The manifest is validated with the
schema below; unknown fields are rejected, and every error names its field.

## Fields

| Field | Type | Required | Rules | Description |
|---|---|---|---|---|
${rows(schema).join("\n")}

## Cross-field rules

- \`model_id\` is required when \`model\` is \`openai-compatible:…\`.
- \`permissions.approve_above_usd\` must not exceed \`permissions.max_tx_usd\`.

## Values

- Periods: ${Object.entries(PERIODS)
    .map(([name, seconds]) => `${code(name)} (${seconds} s)`)
    .join(", ")}.
- Tools: ${TOOL_NAMES.map(code).join(", ")}. See \`docs/package-spec.md\` for what each does.
- Keys never appear in a manifest: \`api_key_env\` names the variable, and the runtime reads it.

## Example

\`\`\`yaml
name: yield-scout
runtime: hosted
model: openai-compatible:https://integrate.api.nvidia.com/v1
model_id: meta/muse-glimmer-30b
api_key_env: NVIDIA_API_KEY
fallback_model: anthropic:claude-opus-5-5
schedule: "*/15 * * * *"
allowance: { mint: USDC, amount: 50, period: weekly }
fee_budget: { sol: 0.02 }
permissions:
  programs: [jupiter, subscriptions]
  destinations: [self]
  max_tx_usd: 25
  approve_above_usd: 10
tools: [pyth-price, yield-data, jupiter-quote, jupiter-swap, balances, pull-allowance, request-topup]
prompt: ./prompt.md
\`\`\`
`;
}

export const MANIFEST_SPEC_PATH = new URL("../../../docs/manifest-spec.md", import.meta.url)
  .pathname;

if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFile(MANIFEST_SPEC_PATH, manifestSpec());
  console.log(`wrote ${MANIFEST_SPEC_PATH}`);
}
