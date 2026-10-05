// The test-token faucet: a signed-in owner asks, the treasury mints test USDC into their wallet's
// token account on devnet. One claim per wallet per day. Testers bring their own devnet SOL (the
// public Solana faucet); the treasury pays only for this transaction and, the first time, the
// rent of the tester's token account.
import type { Address, Signature } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { errorDetail, findToken, mintFor, redact, signAndSend, toBaseUnits } from "@syndromi/core";
import type { ServerContext } from "../context.js";

export const FAUCET_SYMBOL = "USDC";
export const FAUCET_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AMOUNT = 100;

/** Whole test USDC per claim: SYNDROMI_FAUCET_USDC, or 100. */
export function faucetAmount(env: Record<string, string | undefined>): number {
  const value = Number(env.SYNDROMI_FAUCET_USDC);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AMOUNT;
}

export type FaucetResult =
  | { ok: true; amount: number; symbol: string; signature: Signature; nextAt: string }
  | { ok: false; status: 429 | 502 | 503; error: string; nextAt?: string };

export async function claimTestTokens(
  ctx: ServerContext,
  owner: Address,
  now = new Date(),
): Promise<FaucetResult> {
  const treasury = ctx.treasury;
  if (!treasury) {
    return { ok: false, status: 503, error: "the test-token faucet is not set up on this server" };
  }
  const token = findToken(FAUCET_SYMBOL, "devnet");
  if (!token?.mints.devnet) {
    return { ok: false, status: 503, error: "no test token is registered for devnet" };
  }
  const reserved = await ctx.store.reserveFaucetClaim(owner, FAUCET_WINDOW_MS, now);
  if (!reserved.ok) {
    return {
      ok: false,
      status: 429,
      error: "you already claimed test tokens today",
      nextAt: reserved.nextAt,
    };
  }
  const mint = mintFor(token, "devnet");
  const amount = faucetAmount(ctx.config.env);
  try {
    const [ata] = await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signature = await signAndSend(ctx.rpc("devnet"), treasury, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: treasury, owner, mint }),
      getMintToCheckedInstruction({
        mint,
        token: ata,
        mintAuthority: treasury,
        amount: toBaseUnits(amount, token.decimals),
        decimals: token.decimals,
      }),
    ]);
    await ctx.store.confirmFaucetClaim(reserved.id, signature);
    return {
      ok: true,
      amount,
      symbol: token.symbol,
      signature,
      nextAt: new Date(now.getTime() + FAUCET_WINDOW_MS).toISOString(),
    };
  } catch (e) {
    // The mint did not land, so the claim is theirs to make again.
    await ctx.store.releaseFaucetClaim(reserved.id).catch(() => undefined);
    console.error("faucet:", redact(errorDetail(e), ctx.config.env));
    return {
      ok: false,
      status: 502,
      error: "could not send test tokens just now; try again in a minute",
    };
  }
}
