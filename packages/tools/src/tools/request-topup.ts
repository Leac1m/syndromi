import { toBaseUnits, tokenByMint } from "@syndromi/core";
import { z } from "zod";
import { defineTool } from "../tool.js";

export const requestTopUp = defineTool({
  name: "request-topup",
  kind: "write",
  description:
    "Ask the owner for a one-time top-up beyond the regular allowance. The owner approves or " +
    "ignores it; nothing moves until they sign.",
  input: z.object({
    amount: z.number().positive().describe("Amount in whole tokens of the allowance mint"),
    reason: z.string().min(5).max(280).describe("Why the agent needs it, shown to the owner"),
  }),
  async run({ amount, reason }, ctx) {
    const token = tokenByMint(ctx.allowanceMint);
    return {
      type: "request",
      request: {
        kind: "topup",
        mint: ctx.allowanceMint,
        amount: toBaseUnits(amount, token?.decimals ?? 6),
        reason,
      },
      summary: `request a top-up of ${amount} ${token?.symbol ?? "tokens"}: ${reason}`,
    };
  },
});
