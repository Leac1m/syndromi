// The beta treasury: one devnet keypair that is the mint authority of syndromí's own test tokens
// (see scripts/beta-setup.ts). It mints test USDC for testers and holds no one else's funds. It
// exists only when SYNDROMI_TREASURY_KEY is set, and only ever acts on devnet.
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { secretKeyBytes, toUiAmount } from "@syndromi/core";
import type { ServerContext } from "../context.js";

export const TREASURY_KEY_VAR = "SYNDROMI_TREASURY_KEY";

/** Below this the treasury can soon no longer pay for a tester's first token account. */
export const TREASURY_LOW_SOL = 0.05;
const BALANCE_TTL_MS = 5 * 60_000;

export async function loadTreasury(
  env: Record<string, string | undefined>,
): Promise<KeyPairSigner | undefined> {
  const raw = env[TREASURY_KEY_VAR]?.trim();
  if (!raw) return undefined;
  return createKeyPairSignerFromBytes(secretKeyBytes(raw, TREASURY_KEY_VAR));
}

let cached: { sol: number; at: number } | undefined;

/** The treasury's devnet SOL, read at most every five minutes. Undefined if it can't be read. */
export async function treasurySol(
  ctx: ServerContext,
  now = Date.now(),
): Promise<number | undefined> {
  if (!ctx.treasury) return undefined;
  if (cached && now - cached.at < BALANCE_TTL_MS) return cached.sol;
  try {
    const { value } = await ctx.rpc("devnet").getBalance(ctx.treasury.address).send();
    cached = { sol: toUiAmount(value, 9), at: now };
    return cached.sol;
  } catch {
    return cached?.sol;
  }
}

/** Tests start from an empty cache. */
export function forgetTreasuryBalance() {
  cached = undefined;
}
