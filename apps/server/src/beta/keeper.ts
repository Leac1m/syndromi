// Keeps the Orca test pool honest. Testers mostly trade one way (test USDC into JitoSOL), which
// walks the pool's price away from the real one; the policy values swaps at the real price, so a
// drifting pool would make quotes look wrong. Every few minutes the treasury compares the pool
// with the live JitoSOL price and, if they differ by more than the tolerance, mints the token the
// pool is short of and sells it in. It can always do that: it is the mint authority of both.
// Devnet only, and only when the treasury key is set.
import type { Address, Signature } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  createPriceSource,
  errorDetail,
  findToken,
  type PriceSource,
  redact,
  signAndSend,
  type TokenInfo,
  toUiAmount,
} from "@syndromi/core";
import { buildOrcaSwap, fetchTestPool, rebalanceTrade } from "@syndromi/tools";
import type { ServerContext } from "../context.js";

const EVERY_MS = 5 * 60_000;
/** Act when the pool is more than 2% from the live price… */
const TOLERANCE = 0.02;
/** …and put in at most a tenth of the pool's reserve per run, so one bad price cannot wreck it. */
const MAX_SHARE = 0.1;
/** The keeper wants its trade to land; the pool is its own, so generous slippage costs nothing. */
const SLIPPAGE_BPS = 300;

export type KeeperDeps = {
  prices: PriceSource;
  fetchPool: typeof fetchTestPool;
  buildSwap: typeof buildOrcaSwap;
  send: typeof signAndSend;
  tolerance: number;
  maxShare: number;
};

export type KeeperResult =
  | { status: "off" | "no_pool" | "no_price" | "in_range" }
  | { status: "rebalanced"; sold: string; signature: Signature };

const defaults = (ctx: ServerContext): KeeperDeps => ({
  prices: createPriceSource(ctx.config.env),
  fetchPool: fetchTestPool,
  buildSwap: buildOrcaSwap,
  send: signAndSend,
  tolerance: TOLERANCE,
  maxShare: MAX_SHARE,
});

/** One check of the pool against the live price, trading if it has drifted. */
export async function keepPoolOnce(
  ctx: ServerContext,
  overrides: Partial<KeeperDeps> = {},
): Promise<KeeperResult> {
  const treasury = ctx.treasury;
  const usdc = findToken("USDC", "devnet");
  const jito = findToken("JitoSOL", "devnet");
  if (!treasury || !usdc?.mints.devnet || !jito?.mints.devnet) return { status: "off" };
  const deps = { ...defaults(ctx), ...overrides };
  const rpc = ctx.rpc("devnet");

  const pool = await deps.fetchPool(rpc, usdc.mints.devnet, jito.mints.devnet);
  if (!pool) return { status: "no_pool" };
  const [usdcUsd, jitoUsd] = await Promise.all([
    deps.prices.usdPrice(usdc.mints.mainnet),
    deps.prices.usdPrice(jito.mints.mainnet),
  ]);
  if (!usdcUsd || !jitoUsd) return { status: "no_price" };

  // The pool prices its token A in token B, in base units; put the live price in the same terms.
  const byMint = (mint: Address): TokenInfo => (mint === usdc.mints.devnet ? usdc : jito);
  const a = byMint(pool.mintA);
  const b = byMint(pool.mintB);
  const usdOf = (t: TokenInfo) => (t === usdc ? usdcUsd : jitoUsd);
  const targetBPerA = (usdOf(a) / usdOf(b)) * 10 ** (b.decimals - a.decimals);
  const trade = rebalanceTrade(pool, targetBPerA, {
    tolerance: deps.tolerance,
    maxShare: deps.maxShare,
  });
  if (!trade) return { status: "in_range" };

  const token = trade.input === "A" ? a : b;
  const mint = trade.input === "A" ? pool.mintA : pool.mintB;
  const [ata] = await findAssociatedTokenPda({
    owner: treasury.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const swap = await deps.buildSwap(rpc, {
    pool: pool.address,
    inputMint: mint,
    inputAmount: trade.amount,
    slippageBps: SLIPPAGE_BPS,
    signer: treasury,
  });
  const signature = await deps.send(rpc, treasury, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: treasury,
      owner: treasury.address,
      mint,
    }),
    getMintToCheckedInstruction({
      mint,
      token: ata,
      mintAuthority: treasury,
      amount: trade.amount,
      decimals: token.decimals,
    }),
    ...swap.instructions,
  ]);
  return {
    status: "rebalanced",
    sold: `${toUiAmount(trade.amount, token.decimals)} ${token.symbol}`,
    signature,
  };
}

/** Check now and then every five minutes. One check at a time; a failed one is logged and retried next time. */
export function startKeeper(ctx: ServerContext, log: (line: string) => void = console.log) {
  // One price source for the keeper's lifetime, so its short cache is actually used.
  const prices = createPriceSource(ctx.config.env);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await keepPoolOnce(ctx, { prices });
      if (result.status === "rebalanced") {
        log(`keeper: test pool was off the live price; sold ${result.sold} (${result.signature})`);
      } else if (result.status === "no_pool") {
        log("keeper: no test pool on devnet yet (run pnpm beta:setup)");
      }
    } catch (e) {
      log(`keeper: ${redact(errorDetail(e), ctx.config.env)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), EVERY_MS);
  return () => clearInterval(timer);
}
