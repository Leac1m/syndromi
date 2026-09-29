import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { listDelegations, TOKENS, tokenByMint, toUiAmount } from "@syndromi/core";
import { z } from "zod";
import { defineTool } from "../tool.js";

export const balances = defineTool({
  name: "balances",
  kind: "read",
  description:
    "The agent's own balances (SOL and known tokens) and how much of its allowance it can " +
    "still pull this period.",
  input: z.object({}),
  async run(_input, ctx) {
    const { value: lamports } = await ctx.rpc.getBalance(ctx.agent).send();
    const tokens: Record<string, number> = { SOL: toUiAmount(lamports, 9) };
    for (const token of TOKENS) {
      const mint = token.mints[ctx.network];
      if (!mint || token.symbol === "SOL") continue;
      const [ata] = await findAssociatedTokenPda({
        owner: ctx.agent,
        mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const amount = await ctx.rpc
        .getTokenAccountBalance(ata)
        .send()
        .then((r) => BigInt(r.value.amount))
        .catch(() => 0n);
      tokens[token.symbol] = toUiAmount(amount, token.decimals);
    }
    const allowances = (await listDelegations(ctx.rpc, ctx.owner))
      .filter((d) => d.agent === ctx.agent)
      .map((d) => {
        const token = tokenByMint(d.mint);
        const decimals = token?.decimals ?? 6;
        return {
          kind: d.kind,
          token: token?.symbol ?? d.mint,
          remaining: toUiAmount(d.remaining, decimals),
          limit: toUiAmount(d.limit, decimals),
          ...(d.periodEndsAt ? { periodEndsAt: new Date(Number(d.periodEndsAt) * 1000) } : {}),
        };
      });
    return { type: "data", data: { agent: ctx.agent, balances: tokens, allowances } };
  },
});
