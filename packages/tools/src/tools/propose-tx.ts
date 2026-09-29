import { type Address, address, createNoopSigner, isAddress } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { toBaseUnits } from "@syndromi/core";
import { z } from "zod";
import { buildMessage } from "../message.js";
import { resolveToken } from "../tokens.js";
import { defineTool } from "../tool.js";

/**
 * A plain transfer from the agent's wallet. The destination comes from the model, so this is the
 * path a prompt injection would use; the policy's destination allowlist is what stops it.
 */
export const proposeTx = defineTool({
  name: "propose-tx",
  kind: "write",
  description:
    "Propose transferring SOL or a known token from the agent's wallet to an address. " +
    "The policy only allows destinations on the owner's allowlist.",
  input: z.object({
    token: z.string().describe("Symbol, e.g. USDC or SOL"),
    to: z.string().refine(isAddress, { error: "must be a Solana address" }),
    amount: z.number().positive().describe("Amount in whole tokens"),
  }),
  async run(input, ctx) {
    const token = resolveToken(input.token, ctx);
    const to = address(input.to);
    const amount = toBaseUnits(input.amount, token.decimals);
    const agent = createNoopSigner(ctx.agent);
    const instructions =
      token.symbol === "SOL"
        ? [getTransferSolInstruction({ source: agent, destination: to, amount })]
        : [
            await getCreateAssociatedTokenIdempotentInstructionAsync({
              payer: agent,
              owner: to,
              mint: token.mint,
            }),
            getTransferCheckedInstruction({
              source: await ata(ctx.agent, token.mint),
              mint: token.mint,
              destination: await ata(to, token.mint),
              authority: agent,
              amount,
              decimals: token.decimals,
            }),
          ];
    const { message, simulationError } = await buildMessage(ctx, instructions);
    return {
      type: "proposal",
      proposal: {
        agent: ctx.agent,
        tool: "propose-tx",
        message,
        intent: { kind: "transfer", inputMint: token.mint, inputAmount: amount },
      },
      summary: `transfer ${input.amount} ${token.symbol} to ${to}`,
      ...(simulationError ? { simulationError } : {}),
    };
  },
});

const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
