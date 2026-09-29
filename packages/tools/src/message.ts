// Turns tool-built instructions into an unsigned v0 message with the agent as fee payer.
import {
  type Address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  type Instruction,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  estimateComputeUnitLimitFactory,
  getSetComputeUnitLimitInstruction,
} from "@solana-program/compute-budget";
import type { ProposalMessage } from "@syndromi/core";
import type { ToolContext } from "./tool.js";

const MAX_UNITS = 1_400_000;
/** Used when simulation fails; the proposal is still evaluated by the policy but never sent. */
const FALLBACK_UNITS = 400_000;

export async function buildMessage(
  ctx: Pick<ToolContext, "agent" | "rpc">,
  instructions: Instruction[],
  lookupTables: Record<Address, Address[]> = {},
): Promise<{ message: ProposalMessage; simulationError?: string }> {
  const { value: blockhash } = await ctx.rpc.getLatestBlockhash().send();
  const unsized = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(ctx.agent, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, lookupTables),
  );
  let units = FALLBACK_UNITS;
  let simulationError: string | undefined;
  try {
    const estimated = await estimateComputeUnitLimitFactory({ rpc: ctx.rpc })(unsized);
    units = Math.min(MAX_UNITS, Math.ceil(estimated * 1.2));
  } catch (error) {
    simulationError = describeSimulationError(error);
  }
  const message = prependTransactionMessageInstruction(
    getSetComputeUnitLimitInstruction({ units }),
    unsized,
  );
  return simulationError ? { message, simulationError } : { message };
}

/** Kit's estimate error hides the useful part (the cause and program logs) in its context. */
function describeSimulationError(error: unknown): string {
  const e = error as Error & { cause?: Error; context?: { logs?: readonly string[] } };
  const parts = [e.cause?.message ?? e.message];
  const logs = e.context?.logs?.slice(-4);
  if (logs?.length) parts.push(logs.join(" | "));
  return parts.join(": ");
}
