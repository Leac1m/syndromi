// Day-1 spike: a Jupiter swap (USDC → SOL) built from /swap/v2/build and executed on a
// Surfpool mainnet fork. This is the shape the jupiter-swap tool will use: the API returns raw
// instructions, we assemble an unsigned v0 transaction, and only then does anything sign it.
//
// Prerequisite (separate terminal):
//   surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"
//
// Usage: pnpm spike:jupiter [--dexes=<comma list>|all]   (default: classic AMMs only)

import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Instruction,
  pipe,
  prependTransactionMessageInstruction,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  estimateComputeUnitLimitFactory,
  getSetComputeUnitLimitInstruction,
} from "@solana-program/compute-budget";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { explorerTx, SURFPOOL_URL } from "./lib/cluster.js";
import { Report } from "./lib/report.js";

// Mainnet mints, as used in Jupiter's own API examples.
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = address("So11111111111111111111111111111111111111112");
const SWAP_USDC = 10_000_000n; // 10 USDC
const JUPITER_BUILD = "https://api.jup.ag/swap/v2/build";
// Oracle-priced "prop AMMs" (SolFi, ZeroFi, BisonFi, ...) go stale on a fork and revert, so on the
// fork we route through classic AMMs only. Mainnet uses Jupiter's default routing.
const FORK_DEXES = "Whirlpool,Raydium CLMM";
const dexesArg = process.argv.find((a) => a.startsWith("--dexes="))?.slice("--dexes=".length);
const dexes = dexesArg === "all" ? undefined : (dexesArg ?? FORK_DEXES);

type ApiInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
type BuildResponse = {
  inAmount: string;
  outAmount: string;
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

// Explicit type so `report.finish()` (returns never) narrows in control flow.
const report: Report = new Report();
const rpc = createSolanaRpc(SURFPOOL_URL);

async function cheatcode(method: string, params: unknown[]) {
  const res = await fetch(SURFPOOL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
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

// Poll over HTTP: Surfpool's signature subscriptions were flaky with kit's confirmation strategy.
async function waitForConfirmation(signature: Signature) {
  for (let i = 0; i < 30; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not confirmed after 15s: ${signature}`);
}

async function balances(owner: Address, usdcAta: Address) {
  const { value: lamports } = await rpc.getBalance(owner).send();
  const usdc = await rpc
    .getTokenAccountBalance(usdcAta)
    .send()
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  return { lamports, usdc };
}

try {
  await rpc.getHealth().send();
} catch {
  console.error(`Surfpool is not reachable at ${SURFPOOL_URL}. Start it first:
  surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"`);
  process.exit(1);
}

// 1. A fresh taker, funded on the fork with cheatcodes (1 SOL, 20 USDC).
const taker = await generateKeyPairSigner();
const [usdcAta] = await findAssociatedTokenPda({
  mint: USDC,
  owner: taker.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
console.log(`taker  ${taker.address}\n`);
await report.expectOk(
  "fund taker on the fork: 1 SOL + 20 USDC",
  async () => {
    await cheatcode("surfnet_setAccount", [taker.address, { lamports: 1_000_000_000 }]);
    await cheatcode("surfnet_setTokenAccount", [taker.address, USDC, { amount: 20_000_000 }]);
    return balances(taker.address, usdcAta);
  },
  (b) => `${b.lamports} lamports, ${b.usdc} USDC base units`,
);
const before = await balances(taker.address, usdcAta);

// 2. Jupiter /build: raw instructions for 10 USDC → SOL.
const build = await report.expectOk(
  "Jupiter /swap/v2/build returns instructions for 10 USDC → SOL",
  async () => {
    const params = new URLSearchParams({
      inputMint: USDC,
      outputMint: WSOL,
      amount: SWAP_USDC.toString(),
      taker: taker.address,
      slippageBps: "100",
    });
    if (dexes) params.set("dexes", dexes);
    const headers: Record<string, string> = {};
    if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
    const res = await fetch(`${JUPITER_BUILD}?${params}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as BuildResponse;
  },
  (b) => `quote: ${b.inAmount} USDC units → ${b.outAmount} lamports`,
);
if (!build) report.finish();

// 3. Assemble an unsigned v0 transaction against the fork's blockhash, compressed with Jupiter's
//    lookup tables, with a compute-unit limit from simulation.
const instructions = [
  ...build.computeBudgetInstructions,
  ...build.setupInstructions,
  build.swapInstruction,
  ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
  ...build.otherInstructions,
].map(toInstruction);
const { value: blockhash } = await rpc.getLatestBlockhash().send();
const lookupTables = Object.fromEntries(
  Object.entries(build.addressesByLookupTableAddress ?? {}).map(([table, addrs]) => [
    address(table),
    addrs.map(address),
  ]),
);
const unsigned = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(taker, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstructions(instructions, m),
  (m) => compressTransactionMessageUsingAddressLookupTables(m, lookupTables),
);
const units = await report.expectOk(
  "simulate on the fork to size the compute-unit limit",
  () => estimateComputeUnitLimitFactory({ rpc })(unsigned),
  (u) => `${u} CU estimated, limit set to ${Math.ceil(u * 1.2)}`,
);
if (!units) report.finish();
const message = prependTransactionMessageInstruction(
  getSetComputeUnitLimitInstruction({ units: Math.min(1_400_000, Math.ceil(units * 1.2)) }),
  unsigned,
);

// 4. Sign and send to the fork (in syndromí this is where the policy signer sits).
await report.expectOk(
  "sign and execute the swap on the fork",
  async () => {
    const signed = await signTransactionMessageWithSigners(message);
    const signature = await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" })
      .send();
    await waitForConfirmation(signature);
    return signature;
  },
  (sig) => explorerTx(sig, "surfpool"),
);

// 5. USDC went down by exactly 10; SOL went up (net of fees).
const after = await balances(taker.address, usdcAta);
await report.expectOk(
  "USDC −10 and SOL up",
  async () => {
    if (before.usdc - after.usdc !== SWAP_USDC) {
      throw new Error(`USDC changed by ${before.usdc - after.usdc}, expected ${SWAP_USDC}`);
    }
    if (after.lamports <= before.lamports) {
      throw new Error(`SOL did not increase: ${before.lamports} → ${after.lamports}`);
    }
    return after.lamports - before.lamports;
  },
  (gain) => `+${gain} lamports net (quote was ${build.outAmount})`,
);

report.finish();
