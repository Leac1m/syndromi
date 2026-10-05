import { createNoopSigner } from "@solana/kit";
import { toBaseUnits, toUiAmount } from "@syndromi/core";
import { z } from "zod";
import { buildMessage } from "../message.js";
import { buildOrcaSwap, fetchTestPool } from "../orca.js";
import { resolveToken } from "../tokens.js";
import { defineTool, type ToolContext } from "../tool.js";

const swapInput = z.object({
  from: z.string().describe("Symbol to sell, e.g. USDC"),
  to: z.string().describe("Symbol to buy, e.g. JitoSOL"),
  amount: z.number().positive().describe("Amount of `from` to sell, in whole tokens"),
  slippageBps: z.number().int().min(1).max(300).default(100),
});

async function build(input: z.infer<typeof swapInput>, ctx: ToolContext) {
  if (ctx.cluster !== "devnet") {
    throw new Error("the Orca test pool exists on devnet only: use jupiter-quote and jupiter-swap");
  }
  const from = resolveToken(input.from, ctx);
  const to = resolveToken(input.to, ctx);
  if (from.mint === to.mint) throw new Error("from and to are the same token");
  const pool = await fetchTestPool(ctx.rpc, from.mint, to.mint);
  if (!pool) {
    throw new Error(
      `there is no test pool for ${from.symbol}/${to.symbol} on devnet; the test pool trades USDC and JitoSOL`,
    );
  }
  const swap = await buildOrcaSwap(ctx.rpc, {
    pool: pool.address,
    inputMint: from.mint,
    inputAmount: toBaseUnits(input.amount, from.decimals),
    slippageBps: input.slippageBps,
    // Tools never hold a key: the policy signer is the only thing that signs for the agent.
    signer: createNoopSigner(ctx.agent),
  });
  const quote = {
    sell: `${toUiAmount(swap.tokenIn, from.decimals)} ${from.symbol}`,
    buy: `${toUiAmount(swap.tokenEstOut, to.decimals)} ${to.symbol}`,
    minimumReceived: `${toUiAmount(swap.tokenMinOut, to.decimals)} ${to.symbol}`,
    fee: `${toUiAmount(swap.tradeFee, from.decimals)} ${from.symbol}`,
    venue: "Orca test pool (devnet)",
  };
  return { from, to, swap, quote };
}

export const orcaQuote = defineTool({
  name: "orca-quote",
  kind: "read",
  description:
    "Quote a swap on the devnet test pool (Orca) without executing it. Devnet only; it trades " +
    "test USDC and JitoSOL.",
  input: swapInput,
  async run(input, ctx) {
    const { quote } = await build(input, ctx);
    return { type: "data", data: quote };
  },
});

export const orcaSwap = defineTool({
  name: "orca-swap",
  kind: "write",
  description:
    "Propose a swap on the devnet test pool (Orca) from the agent's own wallet. Devnet only; it " +
    "trades test USDC and JitoSOL. Returns an unsigned transaction that the policy checks; it " +
    "may execute, wait for owner approval, or be blocked.",
  input: swapInput,
  async run(input, ctx) {
    const { from, to, swap, quote } = await build(input, ctx);
    const { message, simulationError } = await buildMessage(ctx, swap.instructions);
    return {
      type: "proposal",
      // The value at risk comes from the pool's quote, never from the model's input.
      proposal: {
        agent: ctx.agent,
        tool: "orca-swap",
        message,
        intent: {
          kind: "swap",
          inputMint: from.mint,
          inputAmount: swap.tokenIn,
          outputMint: to.mint,
        },
      },
      summary: `swap ${quote.sell} → ~${quote.buy} (min ${quote.minimumReceived})`,
      ...(simulationError ? { simulationError } : {}),
    };
  },
});
