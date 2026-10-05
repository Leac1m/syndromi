import {
  type DelegationView,
  listDelegations,
  pullAllowance as pullInstructions,
  toBaseUnits,
  tokenByMint,
  toUiAmount,
} from "@syndromi/core";
import { z } from "zod";
import { buildMessage } from "../message.js";
import { defineTool, type ToolContext } from "../tool.js";

export const pullAllowance = defineTool({
  name: "pull-allowance",
  kind: "write",
  description:
    "Pull part of this period's allowance from the owner's wallet into the agent's wallet. " +
    "Fails if it exceeds what is left this period; then pull less, or ask for a top-up.",
  input: z.object({
    amount: z.number().positive().describe("Amount in whole tokens of the allowance mint"),
  }),
  async run({ amount }, ctx) {
    const token = tokenByMint(ctx.allowanceMint);
    const decimals = token?.decimals ?? 6;
    const base = toBaseUnits(amount, decimals);
    const shortfall = await allowanceShortfall(ctx, base, decimals, token?.symbol ?? "tokens");
    if (shortfall) throw new Error(shortfall);
    const instructions = await pullInstructions(ctx.bag, {
      owner: ctx.owner,
      mint: ctx.allowanceMint,
      amount: base,
    });
    const { message, simulationError } = await buildMessage(ctx, instructions);
    return {
      type: "proposal",
      proposal: {
        agent: ctx.agent,
        tool: "pull-allowance",
        message,
        intent: { kind: "pull", inputMint: ctx.allowanceMint, inputAmount: base },
      },
      summary: `pull ${amount} ${token?.symbol ?? "tokens"} from the allowance`,
      ...(simulationError ? { simulationError } : {}),
    };
  },
});

/**
 * Why a pull of `amount` would fail onchain, in words the model can act on; undefined when it
 * fits (or the check itself can't run: the program still enforces the cap).
 */
export async function allowanceShortfall(
  ctx: Pick<ToolContext, "rpc" | "owner" | "agent" | "allowanceMint">,
  amount: bigint,
  decimals: number,
  symbol: string,
): Promise<string | undefined> {
  let delegations: DelegationView[];
  try {
    delegations = await listDelegations(ctx.rpc, ctx.owner, await chainTime(ctx));
  } catch {
    return undefined;
  }
  return shortfallMessage(delegations, ctx, amount, decimals, symbol);
}

export function shortfallMessage(
  delegations: DelegationView[],
  ctx: Pick<ToolContext, "agent" | "allowanceMint">,
  amount: bigint,
  decimals: number,
  symbol: string,
): string | undefined {
  const allowance = delegations.find(
    (d) => d.kind === "allowance" && d.agent === ctx.agent && d.mint === ctx.allowanceMint,
  );
  if (!allowance) {
    return "No allowance is set up for this agent: the owner has not funded it yet, or revoked it. Stop here.";
  }
  if (amount <= allowance.remaining) return undefined;
  const resets = allowance.periodEndsAt
    ? ` It resets ${new Date(Number(allowance.periodEndsAt) * 1000).toISOString().slice(0, 16)}Z.`
    : "";
  const ask = "If you need more before then, ask the owner once with request-topup.";
  if (allowance.remaining === 0n) {
    return `Your ${symbol} allowance for this period is used up.${resets} ${ask}`;
  }
  const left = toUiAmount(allowance.remaining, decimals);
  return `Only ${left} ${symbol} left of your allowance this period.${resets} Pull at most ${left} ${symbol}. ${ask}`;
}

/**
 * The later of the cluster's clock and this machine's: a Surfpool fork may run ahead (time
 * travel), and the latest block time lags the clock a little, which would make a delegation that
 * just landed look not started yet. Erring late only makes the check more lenient.
 */
async function chainTime(ctx: Pick<ToolContext, "rpc">): Promise<bigint> {
  const local = BigInt(Math.floor(Date.now() / 1000));
  try {
    const slot = await ctx.rpc.getSlot().send();
    const time = await ctx.rpc.getBlockTime(slot).send();
    return time !== null && BigInt(time) > local ? BigInt(time) : local;
  } catch {
    return local;
  }
}
