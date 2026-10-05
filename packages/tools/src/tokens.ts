import type { Address } from "@solana/kit";
import { findToken, mintFor, TOKENS, type TokenInfo } from "@syndromi/core";
import type { ToolContext } from "./tool.js";

/** Tokens are named by symbol and resolved only through the registry, never taken as raw mints. */
export function resolveToken(
  symbol: string,
  ctx: Pick<ToolContext, "network">,
): TokenInfo & { mint: Address } {
  const token = findToken(symbol, ctx.network);
  const mint = token?.mints[ctx.network];
  if (!token || !mint) {
    const known = TOKENS.filter((t) => t.mints[ctx.network]).map((t) => t.symbol);
    throw new Error(`unknown token "${symbol}" on ${ctx.network}; known: ${known.join(", ")}`);
  }
  return { ...token, mint: mintFor(token, ctx.network) };
}

export function assertSwapsAvailable(ctx: Pick<ToolContext, "cluster">) {
  if (ctx.cluster === "devnet") {
    throw new Error(
      "Jupiter is mainnet-only: on devnet use orca-quote and orca-swap (the test pool, USDC and JitoSOL)",
    );
  }
}
