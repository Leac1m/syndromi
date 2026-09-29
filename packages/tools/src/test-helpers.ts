// Minimal fakes for tool tests: an RPC whose methods resolve canned values, and a context.
import {
  type Address,
  blockhash,
  createNoopSigner,
  generateKeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { findToken, type Policy, StaticPriceSource } from "@syndromi/core";
import type { ToolContext } from "./tool.js";

type Responses = Record<string, (...args: unknown[]) => unknown>;

export function fakeRpc(overrides: Responses = {}): Rpc<SolanaRpcApi> {
  const defaults: Responses = {
    getLatestBlockhash: () => ({
      value: { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n },
    }),
    simulateTransaction: () => ({ value: { err: null, unitsConsumed: 100_000n, logs: [] } }),
    getBalance: () => ({ value: 1_000_000_000n }),
    getTokenAccountBalance: () => ({ value: { amount: "5000000" } }),
    getProgramAccounts: () => [],
  };
  const all = { ...defaults, ...overrides };
  return new Proxy(
    {},
    {
      get: (_t, method: string) => {
        const respond = all[method];
        if (!respond) throw new Error(`fakeRpc: unexpected ${method}`);
        return (...args: unknown[]) => ({ send: async () => respond(...args) });
      },
    },
  ) as Rpc<SolanaRpcApi>;
}

export const USDC_MAINNET = findToken("USDC", "mainnet")?.mints.mainnet as Address;
export const SOL_MINT = findToken("SOL", "mainnet")?.mints.mainnet as Address;

export const policy: Policy = {
  programs: ["jupiter", "subscriptions"],
  destinations: ["self"],
  maxTxUsd: 25,
  approveAboveUsd: 10,
};

export async function fakeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
  const agent = overrides.agent ?? (await generateKeyPairSigner()).address;
  const owner = (await generateKeyPairSigner()).address;
  const rpc = fakeRpc();
  return {
    agent,
    owner,
    cluster: "fork",
    network: "mainnet",
    rpc,
    prices: new StaticPriceSource({ [USDC_MAINNET]: 1, [SOL_MINT]: 120 }),
    policy,
    allowanceMint: USDC_MAINNET,
    bag: {
      payer: createNoopSigner(agent),
      rpc,
      subscriptions: { instructions: {} as ToolContext["bag"]["subscriptions"]["instructions"] },
    },
    ...overrides,
  };
}
