import { type Address, address } from "@solana/kit";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@solana/subscriptions";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

/** Jupiter aggregator v6 (the swap program in /swap/v2/build responses). */
export const JUPITER_PROGRAM_ADDRESS = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/**
 * Orca Whirlpools: the devnet beta's swap venue (the same program id on mainnet). Copied from the
 * SDK's `WhirlpoolDeployment.devnet.programId`; packages/tools/src/orca.test.ts keeps them equal.
 */
export const ORCA_WHIRLPOOL_PROGRAM_ADDRESS = address(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
);

export {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
};

/** Program names a manifest may list under `permissions.programs`. */
export const PROGRAM_NAMES = ["jupiter", "orca", "token", "system", "subscriptions"] as const;
export type ProgramName = (typeof PROGRAM_NAMES)[number];

/**
 * What each manifest name lets an agent call at the top level. Token and system instructions
 * are still decoded and checked by the policy, so allowing the token program never means
 * "send anywhere".
 */
const EXPANSIONS: Record<ProgramName, Address[]> = {
  jupiter: [JUPITER_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
  // A swap is the Whirlpool instruction, preceded by creating the output token account when the
  // agent has none (the policy checks that account's owner).
  orca: [ORCA_WHIRLPOOL_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS],
  token: [TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS],
  system: [SYSTEM_PROGRAM_ADDRESS],
  // Pulls create the agent's own token account if needed; the policy checks its owner.
  subscriptions: [SUBSCRIPTIONS_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS],
};

/** Always allowed: compute-budget instructions carry no funds. */
const ALWAYS_ALLOWED: Address[] = [COMPUTE_BUDGET_PROGRAM_ADDRESS];

export function allowedPrograms(names: readonly ProgramName[]): Set<Address> {
  return new Set([...ALWAYS_ALLOWED, ...names.flatMap((n) => EXPANSIONS[n])]);
}
