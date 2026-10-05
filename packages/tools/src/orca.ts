// Orca Whirlpools on devnet: where the beta's test tokens trade (Jupiter is mainnet-only). Every
// Orca import in the product lives in this file, so the SDK can be swapped or upgraded in one place.
//
// The SDK (@orca-so/whirlpools 8.0.1, pinned) declares a peer on @solana/kit ^5 and runs here
// under kit 7; scripts/spike-orca.ts is the check for that, and should be run again before the
// pin is moved. The pool is a Splash Pool: one full-range pool per pair, so trading in one
// direction can move its price but never push it out of range.
import {
  createSplashPoolInstructions,
  fetchSplashPool,
  openFullRangePositionInstructions,
  orderMints,
  swapInstructions,
  WhirlpoolDeployment,
} from "@orca-so/whirlpools";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";

/** Orca's own devnet deployment: its program and the config that pools are created under. */
export const ORCA_DEVNET = WhirlpoolDeployment.devnet;

// Each function asks for exactly the RPC methods the SDK call behind it uses.
type PoolRpc = Parameters<typeof fetchSplashPool>[0];
type SwapRpc = Parameters<typeof swapInstructions>[0];
type CreateRpc = Parameters<typeof createSplashPoolInstructions>[0];
type LiquidityRpc = Parameters<typeof openFullRangePositionInstructions>[0];

export type TestPool = {
  address: Address;
  mintA: Address;
  mintB: Address;
  /** Whole token B per whole token A. */
  priceBPerA: number;
  /** Virtual liquidity and the current square-root price (Q64.64), for the keeper's maths. */
  liquidity: bigint;
  sqrtPrice: bigint;
  /** The swap fee, as a fraction of the input (e.g. 0.01). */
  fee: number;
};

/** The Splash Pool for a pair on devnet, or undefined if nobody has created it. */
export async function fetchTestPool(
  rpc: PoolRpc,
  mintOne: Address,
  mintTwo: Address,
): Promise<TestPool | undefined> {
  const [mintA, mintB] = orderMints(mintOne, mintTwo);
  const pool = await fetchSplashPool(rpc, mintA, mintB, ORCA_DEVNET);
  if (!pool.initialized) return undefined;
  return {
    address: pool.address,
    mintA,
    mintB,
    priceBPerA: pool.price,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    fee: pool.feeRate / 1_000_000,
  };
}

export type OrcaSwap = {
  instructions: Instruction[];
  /** What the pool will take and give, in base units. */
  tokenIn: bigint;
  tokenEstOut: bigint;
  tokenMinOut: bigint;
  tradeFee: bigint;
};

/** Unsigned instructions for selling exactly `inputAmount` of `inputMint` into `pool`. */
export async function buildOrcaSwap(
  rpc: SwapRpc,
  args: {
    pool: Address;
    inputMint: Address;
    inputAmount: bigint;
    slippageBps: number;
    /** Whoever owns the tokens; a noop signer when a tool is building for an agent. */
    signer: TransactionSigner;
  },
): Promise<OrcaSwap> {
  const { instructions, quote } = await swapInstructions(
    rpc,
    { inputAmount: args.inputAmount, mint: args.inputMint },
    args.pool,
    {
      slippageToleranceBps: args.slippageBps,
      signer: args.signer,
      whirlpoolDeployment: ORCA_DEVNET,
    },
  );
  return {
    instructions,
    tokenIn: quote.tokenIn,
    tokenEstOut: quote.tokenEstOut,
    tokenMinOut: quote.tokenMinOut,
    tradeFee: quote.tradeFee,
  };
}

/** Instructions that create the pair's Splash Pool at `priceTwoPerOne` (whole `mintTwo` per whole `mintOne`). */
export async function createTestPoolInstructions(
  rpc: CreateRpc,
  args: { mintOne: Address; mintTwo: Address; priceTwoPerOne: number; funder: TransactionSigner },
): Promise<{ instructions: Instruction[]; address: Address }> {
  // Orca refuses mints that are not in its own order, and prices token A in token B.
  const [mintA, mintB] = orderMints(args.mintOne, args.mintTwo);
  const created = await createSplashPoolInstructions(rpc, mintA, mintB, {
    initialPrice: mintA === args.mintOne ? args.priceTwoPerOne : 1 / args.priceTwoPerOne,
    funder: args.funder,
    whirlpoolDeployment: ORCA_DEVNET,
  });
  return { instructions: created.instructions, address: created.poolAddress };
}

/** Instructions that add liquidity across the whole price range, up to the given amounts. */
export async function fullRangeLiquidityInstructions(
  rpc: LiquidityRpc,
  args: {
    pool: TestPool;
    /** The most of each mint to deposit, in base units, keyed by mint. */
    max: Record<Address, bigint>;
    funder: TransactionSigner;
  },
): Promise<{ instructions: Instruction[]; positionMint: Address }> {
  const opened = await openFullRangePositionInstructions(
    rpc,
    args.pool.address,
    { tokenMaxA: args.max[args.pool.mintA] ?? 0n, tokenMaxB: args.max[args.pool.mintB] ?? 0n },
    { funder: args.funder, whirlpoolDeployment: ORCA_DEVNET, slippageToleranceBps: 100 },
  );
  return { instructions: opened.instructions, positionMint: opened.positionMint };
}

/**
 * The trade that brings a full-range pool to `targetBPerA` (in base units of B per base unit of
 * A), or undefined when it is already within `tolerance`. For a full-range position the pool is a
 * constant-product pool with reserves L/√P of A and L·√P of B, so the input needed to reach a
 * new √P is exact up to the fee. `maxShare` caps the trade at that share of the input reserve.
 */
export function rebalanceTrade(
  pool: Pick<TestPool, "liquidity" | "sqrtPrice" | "fee">,
  targetBPerA: number,
  opts: { tolerance: number; maxShare: number },
): { input: "A" | "B"; amount: bigint } | undefined {
  const liquidity = Number(pool.liquidity);
  const sqrtNow = Number(pool.sqrtPrice) / 2 ** 64;
  if (!(liquidity > 0) || !(sqrtNow > 0) || !(targetBPerA > 0)) return undefined;
  const now = sqrtNow ** 2;
  if (Math.abs(now - targetBPerA) / targetBPerA <= opts.tolerance) return undefined;
  const sqrtTarget = Math.sqrt(targetBPerA);
  // Raising the price means the pool takes B and gives A; lowering it, the reverse.
  const input = sqrtTarget > sqrtNow ? "B" : "A";
  const net =
    input === "B" ? liquidity * (sqrtTarget - sqrtNow) : liquidity * (1 / sqrtTarget - 1 / sqrtNow);
  const reserve = input === "B" ? liquidity * sqrtNow : liquidity / sqrtNow;
  const amount = Math.min(net / (1 - pool.fee), reserve * opts.maxShare);
  return amount >= 1 ? { input, amount: BigInt(Math.floor(amount)) } : undefined;
}
