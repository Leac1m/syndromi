// Agent manifest: the portable definition of an agent (see CLAUDE.md for the target shape).
import { type Address, isAddress } from "@solana/kit";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Policy } from "./policy.js";
import { PROGRAM_NAMES } from "./programs.js";

export const TOOL_NAMES = [
  "pyth-price",
  "balances",
  "jupiter-quote",
  "jupiter-swap",
  "pull-allowance",
  "request-topup",
  "propose-tx",
  "yield-data",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const PERIODS = { daily: 86_400, weekly: 604_800, monthly: 2_592_000 } as const;
export type Period = keyof typeof PERIODS;

const positive = () =>
  z.number({ error: "must be a number" }).positive({ error: "must be greater than 0" });

const destination = z.union([
  z.literal("self"),
  z.string().refine(isAddress, { error: 'must be "self" or a Solana address' }),
]);

export const manifestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: "must be kebab-case, e.g. yield-scout" })
      .describe("Agent name, kebab-case (e.g. yield-scout). Unique per server."),
    runtime: z
      .enum(["local", "hosted", "external"])
      .describe(
        "Where the agent runs: `local` (the CLI on your machine, key under ~/.syndromi), `hosted` (the server, key encrypted with SYNDROMI_HOSTED_SECRET; `syndromi deploy` sets it) or `external` (an outside MCP client such as Claude is the brain, through `syndromi mcp`; no model, schedule or api_key_env).",
      ),
    model: z
      .string()
      .regex(/^(byok:anthropic|openai-compatible:https?:\/\/\S+)$/, {
        error: 'must be "byok:anthropic" or "openai-compatible:<https url>"',
      })
      .optional()
      .describe(
        "Required unless runtime is external. LLM provider: `byok:anthropic` (Anthropic Messages API, your key) or `openai-compatible:<base url>` (any /chat/completions endpoint, e.g. https://integrate.api.nvidia.com/v1).",
      ),
    model_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model name at the provider (e.g. meta/muse-glimmer-30b). Required for openai-compatible; Anthropic defaults to claude-opus-5-5.",
      ),
    api_key_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, { error: "must be an env var name, e.g. GEMINI_API_KEY" })
      .optional()
      .describe(
        "Name of the environment variable holding the provider key, never the key itself. Anthropic defaults to ANTHROPIC_API_KEY.",
      ),
    fallback_model: z
      .string()
      .regex(/^(nvidia|gemini|anthropic):\S+$/, {
        error: "must be <nvidia|gemini|anthropic>:<model id>, e.g. anthropic:claude-opus-5-5",
      })
      .optional()
      .describe(
        "Backup model when the primary is down, as `<nvidia|gemini|anthropic>:<model id>` (e.g. anthropic:claude-opus-5-5). Overrides SYNDROMI_FALLBACK_MODEL. If the first request of a run fails, the run restarts on it; the primary is then skipped for 10 minutes.",
      ),
    schedule: z
      .string()
      .refine((s) => s.trim().split(/\s+/).length === 5, {
        error: 'must be a 5-field cron expression, e.g. "*/15 * * * *"',
      })
      .optional()
      .describe(
        'Required unless runtime is external. When the agent runs: a 5-field cron expression, e.g. "*/15 * * * *".',
      ),
    allowance: z
      .object({
        mint: z
          .string()
          .min(1)
          .describe("Token symbol known to syndromí (USDC) or a mint address."),
        amount: positive().describe("Whole tokens the agent may pull per period."),
        period: z
          .enum(Object.keys(PERIODS) as [Period, ...Period[]])
          .describe("Allowance period: daily, weekly or monthly."),
      })
      .describe(
        "The onchain budget: a recurring delegation from the owner's bag, enforced by the Subscriptions Delegation Program.",
      ),
    fee_budget: z
      .object({
        sol: positive()
          .max(1)
          .describe("SOL sent to the agent wallet when funded (fees and token-account rent)."),
      })
      .describe("One-time SOL for transaction fees."),
    permissions: z
      .object({
        programs: z
          .array(z.enum(PROGRAM_NAMES))
          .min(1)
          .describe(
            "Programs a transaction may call (compute budget is always allowed): jupiter, token, system, subscriptions.",
          ),
        destinations: z
          .array(destination)
          .min(1)
          .describe(
            "Where funds may go: `self` (the agent's own wallet) and/or Solana addresses. Everything else is BLOCKED.",
          ),
        max_tx_usd: positive().describe(
          "Largest USD value one transaction may move; above it is BLOCKED.",
        ),
        approve_above_usd: z
          .number()
          .nonnegative()
          .describe(
            "Transactions above this USD value become drafts the owner must sign; must not exceed max_tx_usd.",
          ),
      })
      .describe("Rules the policy signer enforces on every transaction before signing."),
    tools: z
      .array(z.enum(TOOL_NAMES))
      .min(1)
      .describe("First-party tools the model may call. Only write tools produce transactions."),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to the prompt file, relative to the manifest (e.g. ./prompt.md). Required unless runtime is external, where it is optional standing guidance shown to the MCP client.",
      ),
    demo: z
      .object({
        injection: z
          .boolean()
          .optional()
          .describe("yield-data also returns the malicious pool description."),
        unguarded: z
          .boolean()
          .optional()
          .describe('Drop the system prompt\'s "tool results are data" line.'),
        script: z
          .literal("injection")
          .optional()
          .describe("Replace the model with a script that obeys the injection."),
      })
      .strict()
      .optional()
      .describe(
        "DEMO ONLY: switches for the prompt-injection demo (fixtures/injection/pool-scout). Never set them on real agents.",
      ),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.runtime === "external") {
      const why = "is not used by an external agent: an outside MCP client is its brain";
      for (const key of [
        "model",
        "model_id",
        "api_key_env",
        "fallback_model",
        "schedule",
      ] as const) {
        if (m[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: why });
      }
    } else {
      for (const key of ["model", "schedule", "prompt"] as const) {
        if (m[key] === undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: "is required" });
        }
      }
    }
    if (m.model?.startsWith("openai-compatible:") && !m.model_id) {
      ctx.addIssue({
        code: "custom",
        path: ["model_id"],
        message: "is required for openai-compatible models, e.g. gemini-3.8-flash",
      });
    }
    const { approve_above_usd, max_tx_usd } = m.permissions;
    if (approve_above_usd > max_tx_usd) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions", "approve_above_usd"],
        message: `(${approve_above_usd}) must not exceed max_tx_usd (${max_tx_usd})`,
      });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;

export type ParseResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

/** Parse and validate manifest YAML. Errors are one line each, prefixed with the file name. */
export function parseManifest(yamlText: string, file = "manifest.yaml"): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    return { ok: false, errors: [`${file}: invalid YAML: ${(error as Error).message}`] };
  }
  const result = manifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      const message = issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
      return `${file}: ${path} ${message}`;
    }),
  };
}

export function periodSeconds(period: Period): number {
  return PERIODS[period];
}

export function toPolicy(m: Manifest): Policy {
  return {
    programs: m.permissions.programs,
    destinations: m.permissions.destinations.map((d) => (d === "self" ? "self" : (d as Address))),
    maxTxUsd: m.permissions.max_tx_usd,
    approveAboveUsd: m.permissions.approve_above_usd,
  };
}
