import { type Address, generateKeyPairSigner, type Instruction } from "@solana/kit";
import {
  getMintToCheckedInstructionDataDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { findToken, ORCA_WHIRLPOOL_PROGRAM_ADDRESS, StaticPriceSource } from "@syndromi/core";
import type { TestPool } from "@syndromi/tools";
import { fakeRpc } from "@syndromi/tools/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createContext, type ServerContext } from "../context.js";
import { Store } from "../db.js";
import { type KeeperDeps, keepPoolOnce } from "./keeper.js";

const usdc = findToken("USDC", "devnet");
const jito = findToken("JitoSOL", "devnet");
if (!usdc?.mints.devnet || !jito?.mints.devnet) throw new Error("devnet test tokens missing");
const USDC = usdc.mints.devnet;
const JITO = jito.mints.devnet;
const Q64 = 2 ** 64;
const swapIx: Instruction = {
  programAddress: ORCA_WHIRLPOOL_PROGRAM_ADDRESS,
  accounts: [],
  data: new Uint8Array([9]),
};

/** A pool (A = JitoSOL, 9 decimals; B = USDC, 6) priced at `usdcPerJito`. */
const poolAt = (usdcPerJito: number): TestPool => ({
  address: "HRjoKcD6XQWZhnVFyjp7ViZtAuvLtx4wfvLXb2xfvq3H" as Address,
  mintA: JITO,
  mintB: USDC,
  priceBPerA: usdcPerJito,
  liquidity: 1_000_000_000_000n,
  sqrtPrice: BigInt(Math.round(Math.sqrt(usdcPerJito * 10 ** (6 - 9)) * Q64)),
  fee: 0.01,
});

let ctx: ServerContext;
let sent: Instruction[][];
let built: { inputMint: Address; inputAmount: bigint }[];

const deps = (pool: TestPool | undefined, jitoUsd: number | undefined): Partial<KeeperDeps> => ({
  prices: new StaticPriceSource({
    [usdc.mints.mainnet]: 1,
    ...(jitoUsd ? { [jito.mints.mainnet]: jitoUsd } : {}),
  }),
  fetchPool: async () => pool,
  buildSwap: async (_rpc, args) => {
    built.push({ inputMint: args.inputMint, inputAmount: args.inputAmount });
    return {
      instructions: [swapIx],
      tokenIn: args.inputAmount,
      tokenEstOut: 1n,
      tokenMinOut: 1n,
      tradeFee: 0n,
    };
  },
  send: async (_rpc, _payer, instructions) => {
    sent.push([...instructions]);
    return "sig" as never;
  },
});

beforeEach(async () => {
  sent = [];
  built = [];
  ctx = createContext(new Store(":memory:"), {
    publicUrl: "http://localhost:8787",
    token: "t",
    env: {},
    draftTtlMs: 60_000,
    topUpTtlMs: 60_000,
    dashboardOrigins: [],
  });
  ctx.rpc = () => fakeRpc() as never;
  ctx.treasury = await generateKeyPairSigner();
});

describe("the test pool's keeper", () => {
  it("is off without a treasury, and waits when there is no pool or no price", async () => {
    expect(await keepPoolOnce(ctx, deps(undefined, 160))).toEqual({ status: "no_pool" });
    expect(await keepPoolOnce(ctx, deps(poolAt(160), undefined))).toEqual({ status: "no_price" });
    delete ctx.treasury;
    expect(await keepPoolOnce(ctx, deps(poolAt(160), 160))).toEqual({ status: "off" });
    expect(sent).toEqual([]);
  });

  it("leaves a pool alone while it is within 2% of the live price", async () => {
    expect(await keepPoolOnce(ctx, deps(poolAt(160), 162))).toEqual({ status: "in_range" });
    expect(sent).toEqual([]);
  });

  it("mints and sells test USDC when JitoSOL is too cheap in the pool", async () => {
    const result = await keepPoolOnce(ctx, deps(poolAt(150), 160));
    expect(result).toMatchObject({ status: "rebalanced", sold: expect.stringMatching(/ USDC$/) });
    expect(built).toHaveLength(1);
    expect(built[0]?.inputMint).toBe(USDC);
    // One transaction: make sure the account exists, mint exactly what is sold, then the swap.
    const [, mintTo, swap] = sent[0] ?? [];
    expect(mintTo?.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(
      getMintToCheckedInstructionDataDecoder().decode(mintTo?.data as Uint8Array),
    ).toMatchObject({ amount: built[0]?.inputAmount, decimals: 6 });
    expect(swap).toBe(swapIx);
  });

  it("mints and sells test JitoSOL when it is too expensive in the pool", async () => {
    const result = await keepPoolOnce(ctx, deps(poolAt(170), 160));
    expect(result).toMatchObject({
      status: "rebalanced",
      sold: expect.stringMatching(/ JitoSOL$/),
    });
    expect(built[0]?.inputMint).toBe(JITO);
  });
});
