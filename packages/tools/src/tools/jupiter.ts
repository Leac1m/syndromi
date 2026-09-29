import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SURFPOOL_URL, TOKENS, toBaseUnits, toUiAmount } from "@syndromi/core";
import { z } from "zod";
import {
  type BuildResponse,
  FORK_DEXES,
  fetchBuild,
  lookupTables,
  swapInstructions,
} from "../jupiter.js";
import { buildMessage, TransactionTooLargeError } from "../message.js";
import { assertSwapsAvailable, resolveToken } from "../tokens.js";
import { defineTool, type ToolContext } from "../tool.js";

const swapInput = z.object({
  from: z.string().describe("Symbol to sell, e.g. USDC"),
  to: z.string().describe("Symbol to buy, e.g. SOL"),
  amount: z.number().positive().describe("Amount of `from` to sell, in whole tokens"),
  slippageBps: z.number().int().min(1).max(300).default(100),
});

/**
 * Surfpool copies pool accounts from mainnet once and then freezes them, while Jupiter quotes the
 * live pool, so the two drift apart (seen: TooLittleOutputReceived / 0x1787-0x1788 at 1%).
 * Fork only; devnet and mainnet use the requested slippage.
 */
export const FORK_MIN_SLIPPAGE_BPS = 300;

async function build(input: z.infer<typeof swapInput>, ctx: ToolContext, maxAccounts?: number) {
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
      slippageBps:
        ctx.cluster === "fork"
          ? Math.max(input.slippageBps, FORK_MIN_SLIPPAGE_BPS)
          : input.slippageBps,
      // Oracle-priced prop AMMs revert on a fork; route through classic AMMs there.
      ...(ctx.cluster === "fork" ? { dexes: FORK_DEXES } : {}),
      ...(maxAccounts ? { maxAccounts } : {}),
    },
    ctx.jupiter,
  );
  if (ctx.cluster === "fork") await refreshForkPools(response, ctx);
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
    // Multi-hop routes can exceed the 1232-byte or 64-account limits; ask Jupiter for simpler
    // routes until one fits (Jupiter's documented approach: step maxAccounts down and retry).
    for (const [i, maxAccounts] of MAX_ACCOUNTS_STEPS.entries()) {
      const { from, to, response, quote } = await build(input, ctx, maxAccounts);
      const { computeBudget, swap } = swapInstructions(response);
      let built: Awaited<ReturnType<typeof buildMessage>>;
      try {
        built = await buildMessage(ctx, [...computeBudget, ...swap], lookupTables(response));
      } catch (error) {
        if (error instanceof TransactionTooLargeError && i < MAX_ACCOUNTS_STEPS.length - 1)
          continue;
        throw error;
      }
      const { message, simulationError } = built;
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
    }
    throw new Error("unreachable");
  },
});

/**
 * Surfpool copies an account from mainnet on first use and then keeps that copy, while Jupiter
 * routes against live mainnet; stale pools fail with slippage or tick-array errors. Reset the
 * route's writable accounts (pools, tick arrays, vaults) so the fork re-fetches them now. The
 * agent's own wallet and token accounts are never reset: they hold fork-local balances.
 */
async function refreshForkPools(response: BuildResponse, ctx: ToolContext) {
  const keep = new Set<string>([ctx.agent]);
  for (const token of TOKENS) {
    const [ata] = await findAssociatedTokenPda({
      owner: ctx.agent,
      mint: token.mints.mainnet,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    keep.add(ata);
  }
  // Fresh pool state carries mainnet timestamps; a lagging fork clock then trips checks such as
  // Whirlpool's InvalidTimestamp (6022). Move the fork clock to now first (it only moves forward;
  // a rejected "past" target just means the clock is already ahead).
  await surfnet("surfnet_timeTravel", [{ absoluteTimestamp: Date.now() }]);
  const accounts = [
    ...response.setupInstructions,
    response.swapInstruction,
    ...(response.cleanupInstruction ? [response.cleanupInstruction] : []),
  ].flatMap((ix) => ix.accounts);
  const stale = [
    ...new Set(
      accounts
        .filter((a) => a.isWritable && !a.isSigner && !keep.has(a.pubkey))
        .map((a) => a.pubkey),
    ),
  ];
  await Promise.all(stale.map((pubkey) => surfnet("surfnet_resetAccount", [pubkey])));
}

/** A Surfpool cheatcode call; failures are ignored (the swap's simulation reports real problems). */
async function surfnet(method: string, params: unknown[]) {
  await fetch(SURFPOOL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).catch(() => undefined);
}

/** undefined = Jupiter's default (64). */
const MAX_ACCOUNTS_STEPS = [undefined, 48, 36, 28] as const;
