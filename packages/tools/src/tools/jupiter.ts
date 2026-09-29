import { toBaseUnits, toUiAmount } from "@syndromi/core";
import { z } from "zod";
import { FORK_DEXES, fetchBuild, lookupTables, swapInstructions } from "../jupiter.js";
import { buildMessage } from "../message.js";
import { assertSwapsAvailable, resolveToken } from "../tokens.js";
import { defineTool, type ToolContext } from "../tool.js";

const swapInput = z.object({
  from: z.string().describe("Symbol to sell, e.g. USDC"),
  to: z.string().describe("Symbol to buy, e.g. SOL"),
  amount: z.number().positive().describe("Amount of `from` to sell, in whole tokens"),
  slippageBps: z.number().int().min(1).max(300).default(100),
});

async function build(input: z.infer<typeof swapInput>, ctx: ToolContext) {
  assertSwapsAvailable(ctx);
  const from = resolveToken(input.from, ctx);
  const to = resolveToken(input.to, ctx);
  if (from.mint === to.mint) throw new Error("from and to are the same token");
  const response = await fetchBuild(
    {
      inputMint: from.mint,
      outputMint: to.mint,
      amount: toBaseUnits(input.amount, from.decimals),
      taker: ctx.agent,
      slippageBps: input.slippageBps,
      // Oracle-priced prop AMMs revert on a fork; route through classic AMMs there.
      ...(ctx.cluster === "fork" ? { dexes: FORK_DEXES } : {}),
    },
    ctx.jupiter,
  );
  const quote = {
    sell: `${toUiAmount(BigInt(response.inAmount), from.decimals)} ${from.symbol}`,
    buy: `${toUiAmount(BigInt(response.outAmount), to.decimals)} ${to.symbol}`,
    minimumReceived: `${toUiAmount(BigInt(response.otherAmountThreshold), to.decimals)} ${to.symbol}`,
    priceImpactPct: Number(response.priceImpactPct ?? 0),
    route: (response.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean),
  };
  return { from, to, response, quote };
}

export const jupiterQuote = defineTool({
  name: "jupiter-quote",
  kind: "read",
  description: "Quote a token swap on Jupiter without executing it.",
  input: swapInput,
  async run(input, ctx) {
    const { quote } = await build(input, ctx);
    return { type: "data", data: quote };
  },
});

export const jupiterSwap = defineTool({
  name: "jupiter-swap",
  kind: "write",
  description:
    "Propose a token swap on Jupiter from the agent's own wallet. Returns an unsigned " +
    "transaction that the policy checks; it may execute, wait for owner approval, or be blocked.",
  input: swapInput,
  async run(input, ctx) {
    const { from, to, response, quote } = await build(input, ctx);
    const { computeBudget, swap } = swapInstructions(response);
    const { message, simulationError } = await buildMessage(
      ctx,
      [...computeBudget, ...swap],
      lookupTables(response),
    );
    return {
      type: "proposal",
      // The value at risk comes from Jupiter's response, never from the model's input.
      proposal: {
        agent: ctx.agent,
        tool: "jupiter-swap",
        message,
        intent: {
          kind: "swap",
          inputMint: from.mint,
          inputAmount: BigInt(response.inAmount),
          outputMint: to.mint,
        },
      },
      summary: `swap ${quote.sell} → ~${quote.buy} (min ${quote.minimumReceived})`,
      ...(simulationError ? { simulationError } : {}),
    };
  },
});
