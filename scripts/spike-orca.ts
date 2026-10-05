// Beta phase 5 spike: can an Orca Whirlpool be the devnet beta's swap venue?
//
// Orca's kit SDK (@orca-so/whirlpools 8) declares a peer on @solana/kit ^5, and we pin kit 7.
// This runs the whole path on devnet under kit 7 with two throwaway mints: create a Splash Pool
// (full range), add liquidity, then swap the way the orca-swap tool will: instructions built for
// an agent that is only a noop signer, assembled by our own message builder, signed by the agent
// key alone. It reports which top-level programs a swap calls (the policy allowlist needs them)
// and how large the transaction is.
//
// Usage: pnpm spike:orca      (devnet; the payer is the Solana CLI wallet)

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  createSplashPoolInstructions,
  fetchSplashPool,
  openFullRangePositionInstructions,
  orderMints,
  swapInstructions,
  WhirlpoolDeployment,
} from "@orca-so/whirlpools";
import {
  type Address,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  rpcUrlFor,
  secretKeyBytes,
  sendAndConfirm,
  signAndSend,
  withoutEmbeddedSigners,
} from "@syndromi/core";
import { buildMessage } from "@syndromi/tools";
import { explorerTx } from "./lib/cluster.js";
import { ownerKeypairPath } from "./lib/keys.js";
import { Report } from "./lib/report.js";

const DEVNET = WhirlpoolDeployment.devnet;
const report: Report = new Report();
const rpc = createSolanaRpc(rpcUrlFor("devnet"));

const payer = await createKeyPairSignerFromBytes(
  secretKeyBytes(await readFile(ownerKeypairPath(), "utf8"), ownerKeypairPath()),
);
// Which kit the SDK actually runs against here (it declares ^5; pnpm gives it ours).
const require = createRequire(import.meta.url);
const sdkKit = createRequire(require.resolve("@orca-so/whirlpools")).resolve("@solana/kit");
const kitVersion = /@solana\+kit@([\d.]+)/.exec(sdkKit)?.[1] ?? sdkKit;
console.log(`Orca SDK runs against @solana/kit ${kitVersion}; payer ${payer.address}`);

const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

async function createMint(decimals: number): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await signAndSend(rpc, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: await rpc.getMinimumBalanceForRentExemption(space).send(),
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals,
      mintAuthority: payer.address,
      freezeAuthority: null,
    }),
  ]);
  return mint.address;
}

async function mintTo(mint: Address, decimals: number, owner: Address, amount: bigint) {
  await signAndSend(rpc, payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint }),
    getMintToCheckedInstruction({
      mint,
      token: await ata(owner, mint),
      mintAuthority: payer,
      amount,
      decimals,
    }),
  ]);
}

const programs = (instructions: readonly Instruction[]) => [
  ...new Set(instructions.map((ix) => ix.programAddress)),
];

// 1. Two throwaway mints shaped like the beta's: a 6-decimal "USDC" and a 9-decimal "JitoSOL".
const mints = await report.expectOk(
  "create two classic SPL mints and fund the payer",
  async () => {
    const usd = await createMint(6);
    const lst = await createMint(9);
    await mintTo(usd, 6, payer.address, 1_000_000_000_000n); // 1,000,000
    await mintTo(lst, 9, payer.address, 10_000_000_000_000n); // 10,000
    return { usd, lst };
  },
  (m) => `usd ${m.usd}, lst ${m.lst}`,
);
if (!mints) report.finish();
const { usd, lst } = mints;
// Pool creation refuses mints that are not in Orca's own order (by the bytes of the address).
const [mintA, mintB] = orderMints(usd, lst);
// Orca prices token A in token B, with A and B in its own mint order.
const LST_IN_USD = 200;
const initialPrice = mintA === lst ? LST_IN_USD : 1 / LST_IN_USD;

// 2. A Splash Pool: one full-range pool per pair, so trading can never leave its range.
const pool = await report.expectOk(
  "create a Splash Pool on Orca's devnet deployment",
  async () => {
    const created = await createSplashPoolInstructions(rpc, mintA, mintB, {
      initialPrice,
      funder: payer,
      whirlpoolDeployment: DEVNET,
    });
    const signature = await signAndSend(rpc, payer, created.instructions);
    return { ...created, signature };
  },
  (p) =>
    `pool ${p.poolAddress}, rent ${Number(p.initializationCost) / 1e9} SOL, programs ${programs(p.instructions).join(", ")}\n   ${explorerTx(p.signature, "devnet")}`,
);
if (!pool) report.finish();

// 3. Full-range liquidity: 100,000 "USDC" and the matching "JitoSOL".
await report.expectOk(
  "open a full-range position",
  async () => {
    const usdMax = 100_000_000_000n;
    const lstMax = 1_000_000_000_000n;
    const opened = await openFullRangePositionInstructions(
      rpc,
      pool.poolAddress,
      mintA === usd
        ? { tokenMaxA: usdMax, tokenMaxB: lstMax }
        : { tokenMaxA: lstMax, tokenMaxB: usdMax },
      { funder: payer, whirlpoolDeployment: DEVNET, slippageToleranceBps: 100 },
    );
    const signature = await signAndSend(rpc, payer, opened.instructions);
    return { ...opened, signature };
  },
  (o) =>
    `position ${o.positionMint}, rent ${Number(o.initializationCost) / 1e9} SOL\n   ${explorerTx(o.signature, "devnet")}`,
);

await report.expectOk(
  "read the pool back by its token pair",
  () => fetchSplashPool(rpc, usd, lst, DEVNET),
  (p) =>
    p.initialized
      ? `initialized at ${p.address}, price ${p.price} (A per B order), tick spacing ${p.tickSpacing}`
      : "NOT initialized",
);

// 4. The agent's swap: 10 "USDC" → "JitoSOL", with no output token account yet.
const agent: KeyPairSigner = await generateKeyPairSigner();
await report.expectOk(
  "fund an agent with SOL and 50 of the input token",
  async () => {
    await signAndSend(rpc, payer, [
      getTransferSolInstruction({ source: payer, destination: agent.address, amount: 20_000_000n }),
    ]);
    await mintTo(usd, 6, agent.address, 50_000_000n);
    return agent.address;
  },
  (a) => `agent ${a}`,
);

const swapOnce = (label: string) =>
  report.expectOk(
    label,
    async () => {
      // As a tool would: the agent is only a noop signer here; no key is in reach.
      const built = await swapInstructions(
        rpc,
        { inputAmount: 10_000_000n, mint: usd },
        pool.poolAddress,
        {
          slippageToleranceBps: 100,
          signer: createNoopSigner(agent.address),
          whirlpoolDeployment: DEVNET,
        },
      );
      const { message, simulationError } = await buildMessage(
        { agent: agent.address, rpc },
        built.instructions,
      );
      if (simulationError) throw new Error(`simulation failed: ${simulationError}`);
      // As the policy signer does: drop embedded signers, sign with the agent key alone.
      const signed = await signTransactionMessageWithSigners(
        setTransactionMessageFeePayerSigner(agent, withoutEmbeddedSigners(message)),
      );
      const bytes = Buffer.from(getBase64EncodedWireTransaction(signed), "base64").length;
      const signature = await sendAndConfirm(rpc, signed);
      return { built, bytes, signature };
    },
    ({ built, bytes, signature }) =>
      `in ${built.quote.tokenIn}, est out ${built.quote.tokenEstOut}, min out ${built.quote.tokenMinOut}; ` +
      `${built.instructions.length} instruction(s), ${bytes} bytes; programs ${programs(built.instructions).join(", ")}\n   ${explorerTx(signature, "devnet")}`,
  );

await swapOnce("swap as the agent (output token account does not exist yet)");
await swapOnce("swap again (output token account exists)");

report.finish();
