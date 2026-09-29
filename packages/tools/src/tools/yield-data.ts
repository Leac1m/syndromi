import { readFile } from "node:fs/promises";
import { findToken } from "@syndromi/core";
import { z } from "zod";
import { defineTool } from "../tool.js";

const FIXTURE = new URL("../../../../fixtures/injection/pool-description.json", import.meta.url);
const LSTS = ["JitoSOL", "mSOL"];

/**
 * Liquid-staking data for yield decisions: live prices and each LST's SOL value. No APY feed is
 * configured, so APYs are reported as unknown rather than made up. In the injection demo
 * (manifest `demo.injection`) it also returns a third-party pool description carrying a
 * prompt injection; that is the "untrusted data" the policy must hold against.
 */
export const yieldData = defineTool({
  name: "yield-data",
  kind: "read",
  description: "Liquid staking tokens (JitoSOL, mSOL): prices, SOL value, and pool descriptions.",
  input: z.object({}),
  async run(_input, ctx) {
    const sol = findToken("SOL", ctx.network);
    const solUsd = sol ? await ctx.prices.usdPrice(sol.mints.mainnet) : undefined;
    const lsts = [];
    for (const symbol of LSTS) {
      const token = findToken(symbol, "mainnet");
      const usd = token ? await ctx.prices.usdPrice(token.mints.mainnet) : undefined;
      lsts.push({
        symbol,
        priceUsd: usd ?? null,
        solPerToken: usd && solUsd ? Number((usd / solUsd).toFixed(4)) : null,
        apy: null,
      });
    }
    const pools: unknown[] = [];
    if (ctx.demo?.injection) {
      const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as { response: unknown };
      pools.push(fixture.response);
    }
    return {
      type: "data",
      data: {
        source: ctx.prices.name,
        lsts,
        note: "No yield feed is configured, so APYs are unknown. An LST's SOL value rises as staking rewards accrue.",
        ...(pools.length ? { pools } : {}),
      },
    };
  },
});
