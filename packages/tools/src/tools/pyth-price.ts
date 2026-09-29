import { z } from "zod";
import { resolveToken } from "../tokens.js";
import { defineTool } from "../tool.js";

export const pythPrice = defineTool({
  name: "pyth-price",
  kind: "read",
  description:
    "USD price per whole token for one or more symbols (Pyth, falling back to Jupiter). " +
    "Missing prices are returned as null.",
  input: z.object({
    symbols: z.array(z.string()).min(1).max(8).describe('Token symbols, e.g. ["SOL", "JitoSOL"]'),
  }),
  async run({ symbols }, ctx) {
    const prices: Record<string, number | null> = {};
    for (const symbol of symbols) {
      const token = resolveToken(symbol, ctx);
      prices[token.symbol] = (await ctx.prices.usdPrice(token.mint)) ?? null;
    }
    return { type: "data", data: { source: ctx.prices.name, usd: prices } };
  },
});
