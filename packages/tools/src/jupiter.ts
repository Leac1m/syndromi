// Jupiter Swap API v2 /build: raw swap instructions that we assemble into our own transaction.
import {
  AccountRole,
  type Address,
  address,
  getBase64Encoder,
  type Instruction,
} from "@solana/kit";

const JUPITER_BUILD = "https://api.jup.ag/swap/v2/build";

type ApiInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

export type BuildResponse = {
  inAmount: string;
  outAmount: string;
  /** Minimum output after slippage. */
  otherAmountThreshold: string;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

export type BuildParams = {
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  taker: Address;
  slippageBps: number;
  /** Comma-separated DEX labels to route through; omit for Jupiter's default routing. */
  dexes?: string;
};

/**
 * Oracle-priced "prop AMMs" (SolFi, ZeroFi, BisonFi, ...) go stale on a fork and revert, so on
 * the fork we route through classic AMMs only. Mainnet uses Jupiter's default routing.
 */
export const FORK_DEXES = "Whirlpool,Raydium CLMM";

export type JupiterOptions = { apiKey?: string; fetch?: typeof fetch };

export async function fetchBuild(
  p: BuildParams,
  opts: JupiterOptions = { apiKey: process.env.JUPITER_API_KEY },
): Promise<BuildResponse> {
  const params = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    taker: p.taker,
    slippageBps: String(p.slippageBps),
  });
  if (p.dexes) params.set("dexes", p.dexes);
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const res = await (opts.fetch ?? fetch)(`${JUPITER_BUILD}?${params}`, { headers });
  if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as BuildResponse;
}

/** Compute-budget instructions stay top-level; the rest is the swap itself. */
export function swapInstructions(build: BuildResponse) {
  return {
    computeBudget: build.computeBudgetInstructions.map(toInstruction),
    swap: [
      ...build.setupInstructions,
      build.swapInstruction,
      ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
      ...build.otherInstructions,
    ].map(toInstruction),
  };
}

export function lookupTables(build: BuildResponse): Record<Address, Address[]> {
  return Object.fromEntries(
    Object.entries(build.addressesByLookupTableAddress ?? {}).map(([table, addrs]) => [
      address(table),
      addrs.map(address),
    ]),
  );
}

function toInstruction(ix: ApiInstruction): Instruction {
  const role = (a: ApiInstruction["accounts"][number]) =>
    a.isSigner
      ? a.isWritable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : a.isWritable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY;
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({ address: address(a.pubkey), role: role(a) })),
    data: getBase64Encoder().encode(ix.data),
  };
}
