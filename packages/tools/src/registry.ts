import { errorDetail, isTransientNetworkError, type ToolName } from "@syndromi/core";
import {
  describe,
  type Tool,
  type ToolContext,
  type ToolDescriptor,
  type ToolOutcome,
} from "./tool.js";
import { balances } from "./tools/balances.js";
import { jupiterQuote, jupiterSwap } from "./tools/jupiter.js";
import { orcaQuote, orcaSwap } from "./tools/orca.js";
import { proposeTx } from "./tools/propose-tx.js";
import { pullAllowance } from "./tools/pull-allowance.js";
import { pythPrice } from "./tools/pyth-price.js";
import { requestTopUp } from "./tools/request-topup.js";
import { yieldData } from "./tools/yield-data.js";

export const TOOLS: Record<ToolName, Tool> = {
  "pyth-price": pythPrice,
  balances,
  "jupiter-quote": jupiterQuote,
  "jupiter-swap": jupiterSwap,
  "orca-quote": orcaQuote,
  "orca-swap": orcaSwap,
  "pull-allowance": pullAllowance,
  "request-topup": requestTopUp,
  "propose-tx": proposeTx,
  "yield-data": yieldData,
};

export type Toolset = {
  tools: readonly Tool[];
  describe(): ToolDescriptor[];
  /** Validate input, run the tool, and enforce its permission kind. Never throws. */
  call(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome>;
};

/** The tools a manifest enables. Calls to anything else are refused. */
export function createToolset(
  names: readonly ToolName[],
  tools: Record<string, Tool> = TOOLS,
): Toolset {
  const enabled = names.map((name) => {
    const tool = tools[name];
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  });
  return {
    tools: enabled,
    describe: () => enabled.map(describe),
    async call(name, input, ctx) {
      const tool = enabled.find((t) => t.name === name);
      if (!tool) return { type: "error", error: `tool "${name}" is not enabled for this agent` };
      const parsed = tool.input.safeParse(input ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "input"}: ${i.message}`,
        );
        return { type: "error", error: `invalid input for ${name}: ${issues.join("; ")}` };
      }
      try {
        const result = await runWithRetry(() => tool.run(parsed.data, ctx));
        if (tool.kind === "read" && result.type !== "data") {
          return {
            type: "error",
            error: `read-only tool ${name} returned a ${result.type}; discarded`,
          };
        }
        return result;
      } catch (error) {
        return { type: "error", error: `${name} failed: ${errorDetail(error)}` };
      }
    },
  };
}

const RETRY_DELAYS_MS = [300, 900];

/**
 * Tools only read or build unsigned transactions (nothing is sent here), so a network hiccup is
 * safe to retry. Anything that is not a network error fails at once.
 */
async function runWithRetry<T>(run: () => Promise<T>): Promise<T> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return run();
}
