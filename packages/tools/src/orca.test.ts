import { type Address, createNoopSigner, type Instruction } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  evaluate,
  findToken,
  ORCA_WHIRLPOOL_PROGRAM_ADDRESS,
  type Policy,
  StaticPriceSource,
} from "@syndromi/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOrcaSwap,
  fetchTestPool,
  ORCA_DEVNET,
  rebalanceTrade,
  type TestPool,
} from "./orca.js";
import { createToolset } from "./registry.js";
import { fakeContext } from "./test-helpers.js";

// The pool lookup and the swap builder talk to devnet; everything else in the module is real.
vi.mock("./orca.js", async (original) => ({
  ...(await original<typeof import("./orca.js")>()),
  fetchTestPool: vi.fn(),
  buildOrcaSwap: vi.fn(),
}));

const usdc = findToken("USDC", "devnet");
const jito = findToken("JitoSOL", "devnet");
if (!usdc?.mints.devnet || !jito?.mints.devnet) throw new Error("devnet test tokens missing");
const USDC = usdc.mints.devnet;
const JITO = jito.mints.devnet;
const prices = new StaticPriceSource({ [usdc.mints.mainnet]: 1, [jito.mints.mainnet]: 200 });
const POOL = "CyLhpqLzw62Pmd7LbWqEEZ1LYHee7jta1M92NjdCNyCk" as Address;
const pool: TestPool = {
  address: POOL,
  mintA: USDC,
  mintB: JITO,
  priceBPerA: 0.005,
  liquidity: 1n,
  sqrtPrice: 1n,
  fee: 0.01,
};
const orcaPolicy: Policy = {
  programs: ["orca", "subscriptions"],
  destinations: ["self"],
  maxTxUsd: 10,
  approveAboveUsd: 5,
};

const devnet = () =>
  fakeContext({ cluster: "devnet", network: "devnet", prices, policy: orcaPolicy });

/** What the SDK returns for a first swap: create the output account, then the Whirlpool swap. */
async function swapInstructionsFor(agent: Address): Promise<Instruction[]> {
  const [ata] = await findAssociatedTokenPda({
    owner: agent,
    mint: JITO,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(agent),
      owner: agent,
      mint: JITO,
      ata,
    }),
    { programAddress: ORCA_WHIRLPOOL_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array([1]) },
  ];
}

beforeEach(() => {
  vi.mocked(fetchTestPool).mockReset().mockResolvedValue(pool);
  vi.mocked(buildOrcaSwap)
    .mockReset()
    .mockImplementation(async (_rpc, args) => ({
      instructions: await swapInstructionsFor(args.signer.address),
      // Deliberately not the amount asked for, to show where the intent comes from.
      tokenIn: 2_990_000n,
      tokenEstOut: 14_800_000n,
      tokenMinOut: 14_652_000n,
      tradeFee: 29_900n,
    }));
});

describe("the Orca program id", () => {
  it("in the policy allowlist is the one the SDK deploys to on devnet", () => {
    expect(ORCA_DEVNET.programId).toBe(ORCA_WHIRLPOOL_PROGRAM_ADDRESS);
  });
});

describe("orca-swap and orca-quote", () => {
  const tools = createToolset(["orca-quote", "orca-swap"]);

  it("proposes a swap valued by the pool's quote, built for a keyless agent, and the policy allows it", async () => {
    const ctx = await devnet();
    const out = await tools.call("orca-swap", { from: "USDC", to: "JitoSOL", amount: 3 }, ctx);
    if (out.type !== "proposal") throw new Error(`expected a proposal, got ${JSON.stringify(out)}`);
    expect(out.proposal.intent).toEqual({
      kind: "swap",
      inputMint: USDC,
      inputAmount: 2_990_000n,
      outputMint: JITO,
    });
    expect(out.summary).toBe("swap 2.99 USDC → ~0.0148 JitoSOL (min 0.014652 JitoSOL)");
    expect(out.proposal.message.feePayer.address).toBe(ctx.agent);
    const args = vi.mocked(buildOrcaSwap).mock.calls[0]?.[1];
    expect(args).toMatchObject({
      pool: POOL,
      inputMint: USDC,
      inputAmount: 3_000_000n,
      slippageBps: 100,
    });
    // The builder is handed the agent's address only; no key reaches a tool.
    expect(args?.signer.address).toBe(ctx.agent);
    expect("keyPair" in (args?.signer ?? {})).toBe(false);

    expect((await evaluate(out.proposal, orcaPolicy, prices)).verdict).toBe("allow");
    const jupiterOnly = await evaluate(
      out.proposal,
      { ...orcaPolicy, programs: ["jupiter"] },
      prices,
    );
    expect(jupiterOnly.verdict).toBe("block");
  });

  it("holds a swap above the owner's threshold and blocks one above the cap", async () => {
    const ctx = await devnet();
    const sized = async (tokenIn: bigint) => {
      vi.mocked(buildOrcaSwap).mockImplementationOnce(async (_rpc, args) => ({
        instructions: await swapInstructionsFor(args.signer.address),
        tokenIn,
        tokenEstOut: 1n,
        tokenMinOut: 1n,
        tradeFee: 0n,
      }));
      const out = await tools.call("orca-swap", { from: "USDC", to: "JitoSOL", amount: 1 }, ctx);
      if (out.type !== "proposal") throw new Error("expected a proposal");
      return (await evaluate(out.proposal, orcaPolicy, prices)).verdict;
    };
    expect(await sized(6_000_000n)).toBe("needs_approval");
    expect(await sized(12_000_000n)).toBe("block");
  });

  it("quotes without proposing anything", async () => {
    const out = await tools.call(
      "orca-quote",
      { from: "USDC", to: "JitoSOL", amount: 3 },
      await devnet(),
    );
    expect(out).toEqual({
      type: "data",
      data: {
        sell: "2.99 USDC",
        buy: "0.0148 JitoSOL",
        minimumReceived: "0.014652 JitoSOL",
        fee: "0.0299 USDC",
        venue: "Orca test pool (devnet)",
      },
    });
  });

  it("exists on devnet only, and says so when there is no pool for the pair", async () => {
    const fork = await tools.call(
      "orca-swap",
      { from: "USDC", to: "JitoSOL", amount: 3 },
      await fakeContext(),
    );
    expect(fork).toMatchObject({
      type: "error",
      error: expect.stringMatching(/devnet only.*jupiter-swap/),
    });
    expect(buildOrcaSwap).not.toHaveBeenCalled();

    vi.mocked(fetchTestPool).mockResolvedValue(undefined);
    const none = await tools.call(
      "orca-quote",
      { from: "USDC", to: "JitoSOL", amount: 3 },
      await devnet(),
    );
    expect(none).toMatchObject({
      type: "error",
      error: expect.stringMatching(/no test pool for USDC\/JitoSOL/),
    });
  });
});

describe("rebalanceTrade", () => {
  const Q64 = 2 ** 64;
  const fee = 0.01;
  const liquidity = 1e12;
  /** A pool whose price (B per A, base units) is `price`. */
  const at = (price: number) => ({
    liquidity: BigInt(liquidity),
    sqrtPrice: BigInt(Math.round(Math.sqrt(price) * Q64)),
    fee,
  });
  /** The price a constant-product pool lands on after taking `amount` of `input` (less the fee). */
  const after = (price: number, trade: { input: "A" | "B"; amount: bigint }) => {
    const sqrt = Math.sqrt(price);
    const net = Number(trade.amount) * (1 - fee);
    const next = trade.input === "B" ? sqrt + net / liquidity : 1 / (1 / sqrt + net / liquidity);
    return next ** 2;
  };
  const loose = { tolerance: 0.02, maxShare: 1 };

  it("does nothing while the pool is within tolerance", () => {
    expect(rebalanceTrade(at(4), 4.05, loose)).toBeUndefined();
    expect(rebalanceTrade(at(4), 3.95, loose)).toBeUndefined();
  });

  it("buys A with B to raise the price to the target, and the reverse to lower it", () => {
    const up = rebalanceTrade(at(4), 5, loose);
    expect(up?.input).toBe("B");
    expect(after(4, up as NonNullable<typeof up>)).toBeCloseTo(5, 6);

    const down = rebalanceTrade(at(4), 3, loose);
    expect(down?.input).toBe("A");
    expect(after(4, down as NonNullable<typeof down>)).toBeCloseTo(3, 6);
  });

  it("moves only part of the way when the trade would exceed its share of the pool", () => {
    const capped = rebalanceTrade(at(4), 16, { tolerance: 0.02, maxShare: 0.1 });
    // The B reserve at price 4 is L·√4; a tenth of it is the most one run may put in.
    expect(capped).toEqual({ input: "B", amount: BigInt(liquidity * 2 * 0.1) });
    const landed = after(4, capped as NonNullable<typeof capped>);
    expect(landed).toBeGreaterThan(4);
    expect(landed).toBeLessThan(16);
  });

  it("ignores an empty pool or a missing price", () => {
    expect(rebalanceTrade({ liquidity: 0n, sqrtPrice: 1n, fee }, 5, loose)).toBeUndefined();
    expect(rebalanceTrade(at(4), Number.NaN, loose)).toBeUndefined();
  });
});
