import { pullAllowance as pullInstructions, toBaseUnits, tokenByMint } from "@syndromi/core";
import { z } from "zod";
import { buildMessage } from "../message.js";
import { defineTool } from "../tool.js";

export const pullAllowance = defineTool({
  name: "pull-allowance",
  kind: "write",
  description:
    "Pull part of this period's allowance from the owner's bag into the agent's wallet. " +
    "Fails onchain if it exceeds what is left this period.",
  input: z.object({
    amount: z.number().positive().describe("Amount in whole tokens of the allowance mint"),
  }),
  async run({ amount }, ctx) {
    const token = tokenByMint(ctx.allowanceMint);
    const decimals = token?.decimals ?? 6;
    const base = toBaseUnits(amount, decimals);
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
