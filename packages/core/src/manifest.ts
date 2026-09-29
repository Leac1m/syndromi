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
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: "must be kebab-case, e.g. yield-scout" }),
    runtime: z.enum(["local", "hosted"]),
    model: z.string().regex(/^(byok:anthropic|openai-compatible:https?:\/\/\S+)$/, {
      error: 'must be "byok:anthropic" or "openai-compatible:<https url>"',
    }),
    schedule: z.string().refine((s) => s.trim().split(/\s+/).length === 5, {
      error: 'must be a 5-field cron expression, e.g. "*/15 * * * *"',
    }),
    allowance: z.object({
      mint: z.string().min(1),
      amount: positive(),
      period: z.enum(Object.keys(PERIODS) as [Period, ...Period[]]),
    }),
    fee_budget: z.object({ sol: positive().max(1) }),
    permissions: z.object({
      programs: z.array(z.enum(PROGRAM_NAMES)).min(1),
      destinations: z.array(destination).min(1),
      max_tx_usd: positive(),
      approve_above_usd: z.number().nonnegative(),
    }),
    tools: z.array(z.enum(TOOL_NAMES)).min(1),
    prompt: z.string().min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
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
