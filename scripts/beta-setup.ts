// Sets up the devnet beta's own test tokens. Safe to run again: it only creates what is missing.
//
//   1. The treasury keypair: SYNDROMI_TREASURY_KEY if set, else ~/.syndromi/treasury.json
//      (created on first run). It is the mint authority, so the server needs the same key.
//   2. A little devnet SOL for it, sent from the Solana CLI keypair when it is short.
//   3. Two classic SPL Token mints with no freeze authority: test USDC (6 decimals) and test
//      JitoSOL (9 decimals). They are registered in packages/core/src/tokens.ts as the devnet
//      twins of the mainnet tokens, so prices and templates work unchanged.
//
//   4. An Orca Splash Pool (full range) for the pair, created at the live JitoSOL price and
//      funded from freshly minted tokens, so agents have somewhere to swap on devnet.
//
// Devnet only. Run with: pnpm beta:setup
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  fetchMaybeMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  createPriceSource,
  explorerTx,
  findToken,
  generateAgentKeypair,
  redact,
  rpcUrlFor,
  secretKeyBytes,
  signAndSend,
  syndromiHome,
  toBaseUnits,
  toUiAmount,
} from "@syndromi/core";
import {
  createTestPoolInstructions,
  fetchTestPool,
  fullRangeLiquidityInstructions,
} from "@syndromi/tools";
import { ownerKeypairPath } from "./lib/keys.js";

const TEST_TOKENS = [
  { symbol: "USDC", decimals: 6 },
  { symbol: "JitoSOL", decimals: 9 },
] as const;
/** Test USDC put into the pool, with the matching JitoSOL: deep enough that a tester's swap barely moves it. */
const POOL_USDC = 1_000_000;
const MIN_SOL = 0.3;
const TOP_UP_LAMPORTS = 1_000_000_000n;

const home = syndromiHome(process.env.SYNDROMI_HOME);
const treasuryFile = join(home, "treasury.json");
const stateFile = join(home, "beta-devnet.json");
const rpc = createSolanaRpc(rpcUrlFor("devnet"));

async function treasury(): Promise<KeyPairSigner> {
  const fromEnv = process.env.SYNDROMI_TREASURY_KEY?.trim();
  if (fromEnv) {
    return createKeyPairSignerFromBytes(secretKeyBytes(fromEnv, "SYNDROMI_TREASURY_KEY"));
  }
  const existing = await readFile(treasuryFile, "utf8").catch(() => undefined);
  if (existing) return createKeyPairSignerFromBytes(secretKeyBytes(existing, treasuryFile));
  const { signer, secretKey } = await generateAgentKeypair();
  await mkdir(home, { recursive: true });
  await writeFile(treasuryFile, JSON.stringify([...secretKey]), { mode: 0o600 });
  await chmod(treasuryFile, 0o600);
  console.log(
    `Created the treasury keypair at ${treasuryFile} (keep it private; never commit it).`,
  );
  return signer;
}

const solOf = async (who: Address) => toUiAmount((await rpc.getBalance(who).send()).value, 9);

async function ensureSol(signer: KeyPairSigner) {
  const sol = await solOf(signer.address);
  if (sol >= MIN_SOL) return sol;
  const cliKey = await readFile(ownerKeypairPath(), "utf8").catch(() => undefined);
  if (!cliKey) {
    throw new Error(
      `the treasury ${signer.address} holds ${sol} devnet SOL and needs at least ${MIN_SOL}. ` +
        `Send it some (https://faucet.solana.com) and run this again.`,
    );
  }
  const payer = await createKeyPairSignerFromBytes(secretKeyBytes(cliKey, ownerKeypairPath()));
  const signature = await signAndSend(rpc, payer, [
    getTransferSolInstruction({
      source: payer,
      destination: signer.address,
      amount: TOP_UP_LAMPORTS,
    }),
  ]);
  console.log(
    `Sent 1 devnet SOL from the Solana CLI wallet ${payer.address} to the treasury: ${explorerTx(signature, "devnet")}`,
  );
  return solOf(signer.address);
}

/** A mint counts as ours when it exists and the treasury is its mint authority. */
async function isOurs(mint: Address | undefined, authority: Address) {
  if (!mint) return false;
  const account = await fetchMaybeMint(rpc, mint);
  if (!account.exists) return false;
  const { mintAuthority } = account.data;
  return mintAuthority.__option === "Some" && mintAuthority.value === authority;
}

async function createMint(signer: KeyPairSigner, decimals: number): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const lamports = await rpc.getMinimumBalanceForRentExemption(space).send();
  await signAndSend(rpc, signer, [
    getCreateAccountInstruction({
      payer: signer,
      newAccount: mint,
      lamports,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals,
      mintAuthority: signer.address,
      freezeAuthority: null,
    }),
  ]);
  return mint.address;
}

/** Whole test USDC per whole test JitoSOL, from the mainnet tokens' live prices. */
async function livePrice(): Promise<number> {
  const prices = createPriceSource();
  const [usdc, jito] = await Promise.all(
    TEST_TOKENS.map(({ symbol }) => {
      const mint = findToken(symbol, "mainnet")?.mints.mainnet;
      return mint ? prices.usdPrice(mint) : undefined;
    }),
  );
  if (!usdc || !jito) throw new Error("no live price for USDC or JitoSOL; try again in a minute");
  return jito / usdc;
}

async function ensurePool(signer: KeyPairSigner, usdc: Address, jito: Address) {
  let pool = await fetchTestPool(rpc, usdc, jito);
  const usdcPerJito = await livePrice();
  if (!pool) {
    const created = await createTestPoolInstructions(rpc, {
      mintOne: jito,
      mintTwo: usdc,
      priceTwoPerOne: usdcPerJito,
      funder: signer,
    });
    const signature = await signAndSend(rpc, signer, created.instructions);
    console.log(`Created the test pool ${created.address}: ${explorerTx(signature, "devnet")}`);
    pool = await fetchTestPool(rpc, usdc, jito);
    if (!pool) throw new Error("the pool was created but cannot be read back yet; run this again");
  }
  if (pool.liquidity === 0n) {
    // Mint a little more JitoSOL than the price implies: the deposit takes what it needs.
    const max: Record<Address, bigint> = {
      [usdc]: toBaseUnits(POOL_USDC, 6),
      [jito]: toBaseUnits((POOL_USDC / usdcPerJito) * 1.05, 9),
    };
    const mintTo = async (mint: Address, decimals: number) => [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: signer.address,
        mint,
      }),
      getMintToCheckedInstruction({
        mint,
        token: (
          await findAssociatedTokenPda({
            owner: signer.address,
            mint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          })
        )[0],
        mintAuthority: signer,
        amount: max[mint] ?? 0n,
        decimals,
      }),
    ];
    await signAndSend(rpc, signer, [...(await mintTo(usdc, 6)), ...(await mintTo(jito, 9))]);
    const opened = await fullRangeLiquidityInstructions(rpc, { pool, max, funder: signer });
    const signature = await signAndSend(rpc, signer, opened.instructions);
    console.log(
      `Added full-range liquidity (position ${opened.positionMint}): ${explorerTx(signature, "devnet")}`,
    );
    pool = (await fetchTestPool(rpc, usdc, jito)) ?? pool;
  }
  const poolUsdcPerJito = pool.mintA === jito ? pool.priceBPerA : 1 / pool.priceBPerA;
  console.log(
    `Test pool: ${pool.address} (Orca Splash Pool, fee ${pool.fee * 100}%), 1 JitoSOL = ` +
      `${poolUsdcPerJito.toFixed(2)} USDC in the pool, ${usdcPerJito.toFixed(2)} live`,
  );
}

async function main() {
  const signer = await treasury();
  console.log(`Treasury: ${signer.address}`);
  console.log(`Treasury SOL (devnet): ${await ensureSol(signer)}`);

  const state = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}")) as Record<
    string,
    Address
  >;
  let unregistered = false;
  for (const { symbol, decimals } of TEST_TOKENS) {
    const registered = findToken(symbol, "devnet")?.mints.devnet;
    let mint: Address;
    if (await isOurs(registered, signer.address)) {
      mint = registered as Address;
      console.log(`test ${symbol}: ${mint} (registered)`);
    } else if (await isOurs(state[symbol], signer.address)) {
      mint = state[symbol] as Address;
      unregistered = true;
      console.log(`test ${symbol}: ${mint} (created earlier, not yet in the registry)`);
    } else {
      mint = await createMint(signer, decimals);
      unregistered = true;
      console.log(`test ${symbol}: ${mint} (created now, ${decimals} decimals)`);
    }
    state[symbol] = mint;
  }
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  await ensurePool(signer, state.USDC as Address, state.JitoSOL as Address);

  if (unregistered) {
    console.log(
      "\nNext: put these addresses in packages/core/src/tokens.ts as the tokens' `devnet` mints:",
    );
    for (const { symbol } of TEST_TOKENS) console.log(`  ${symbol}: ${state[symbol]}`);
  }
  console.log(
    "\nThe server needs the same treasury: set SYNDROMI_TREASURY_KEY to the contents of " +
      `${treasuryFile} (a JSON byte array) in its environment.`,
  );
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
