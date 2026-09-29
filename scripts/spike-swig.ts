// Day-1 spike (timeboxed): can Swig enforce syndromí's outflow rules onchain?
// Runs on the Surfpool mainnet fork against the real Swig program.
//
// The owner creates a Swig and funds its wallet with USDC. The agent gets a role limited to the
// token program plus a token destination limit (5 USDC, only to the agent's own account).
// Checks: transfer to self succeeds; transfer to an unknown address fails; exceeding the cap
// fails; and whether a Jupiter swap can be signed through a Swig role at all.
//
// Usage: pnpm spike:swig   (Surfpool must be running, see spike-jupiter.ts)

import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  fetchSwig,
  findSwigPda,
  getAddAuthorityInstructions,
  getCreateSwigInstruction,
  getSignInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/kit";
// The kit package re-exports these in its types but not in its ESM build.
import { Actions, createEd25519AuthorityInfo } from "@swig-wallet/lib";
import { explorerTx } from "./lib/cluster.js";
import { FORK_DEXES, fetchBuild, lookupTables, swapInstructions } from "./lib/jupiter.js";
import { Report } from "./lib/report.js";
import { assertSurfpoolRunning, cheatcode, forkRpc, sendToFork } from "./lib/surfpool.js";

const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = address("So11111111111111111111111111111111111111112");
const JUPITER_PROGRAM = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const usdc = (n: number) => BigInt(n * 1_000_000);

// @swig-wallet/kit is built on @solana/kit 2. Its instructions and RPC have the same runtime
// shape as kit 7's, so the boundary is crossed with casts in exactly these two helpers.
const swigRpc = forkRpc as unknown as Parameters<typeof fetchSwig>[0];
const asKit7 = (ixs: unknown) => ixs as Instruction[];
const asSwig = (ixs: Instruction[]) => ixs as unknown as Parameters<typeof getSignInstructions>[2];

const report: Report = new Report();
await assertSurfpoolRunning();

async function send(
  feePayer: KeyPairSigner,
  instructions: Instruction[],
  lookupTables: Record<Address, Address[]> = {},
) {
  const { value: blockhash } = await forkRpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, lookupTables),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const size = getTransactionEncoder().encode(signed).length;
  return { signature: await sendToFork(signed), size };
}
const link = (r: { signature: string; size: number }) =>
  `${r.size} bytes ${explorerTx(r.signature, "surfpool")}`;
const ata = async (owner: Address) =>
  (await findAssociatedTokenPda({ mint: USDC, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

// 1. Owner, agent, and an attacker address; owner and agent get SOL on the fork.
const owner = await generateKeyPairSigner();
const agent = await generateKeyPairSigner();
const attacker = await generateKeyPairSigner();
for (const who of [owner, agent]) {
  await cheatcode("surfnet_setAccount", [who.address, { lamports: 1_000_000_000 }]);
}
console.log(`owner  ${owner.address}\nagent  ${agent.address}\n`);

// 2. Owner creates a Swig with a root role that can do everything.
const swigId = crypto.getRandomValues(new Uint8Array(32));
const swigAddress = await findSwigPda(swigId);
await report.expectOk(
  "owner creates a Swig (root role: all)",
  async () =>
    send(
      owner,
      asKit7([
        await getCreateSwigInstruction({
          payer: owner.address,
          id: swigId,
          actions: Actions.set().all().get(),
          authorityInfo: createEd25519AuthorityInfo(owner.address),
        }),
      ]),
    ),
  link,
);

// 3. Agent role: token program only, and at most 5 USDC, only to the agent's own USDC account.
const agentAta = await ata(agent.address);
const attackerAta = await ata(attacker.address);
let swig = await fetchSwig(swigRpc, swigAddress);
const rootRole = swig.findRolesByEd25519SignerPk(owner.address)[0];
if (!rootRole) throw new Error("root role not found");
await report.expectOk(
  "owner adds agent role: token program + 5 USDC to agent's own account only",
  async () =>
    send(
      owner,
      asKit7(
        await getAddAuthorityInstructions(
          swig,
          rootRole.id,
          createEd25519AuthorityInfo(agent.address),
          Actions.set()
            .programLimit({ programId: TOKEN_PROGRAM_ADDRESS })
            .tokenDestinationLimit({ mint: USDC, amount: usdc(5), destination: agentAta })
            .get(),
        ),
      ),
    ),
  link,
);

// 4. Fund the Swig wallet with 20 USDC; create the agent's and attacker's USDC accounts.
swig = await fetchSwig(swigRpc, swigAddress);
const agentRole = swig.findRolesByEd25519SignerPk(agent.address)[0];
if (!agentRole) throw new Error("agent role not found");
const agentRoleId: number = agentRole.id;
const swigWallet = await getSwigWalletAddress(swig);
const swigAta = await ata(swigWallet);
await cheatcode("surfnet_setTokenAccount", [swigWallet, USDC, { amount: 20_000_000 }]);
await cheatcode("surfnet_setTokenAccount", [agent.address, USDC, { amount: 0 }]);
await cheatcode("surfnet_setTokenAccount", [attacker.address, USDC, { amount: 0 }]);

// The agent signs a USDC transfer whose authority is the Swig wallet, wrapped by Swig.
async function agentTransfer(destination: Address, amount: bigint) {
  const inner = getTransferCheckedInstruction({
    source: swigAta,
    mint: USDC,
    destination,
    authority: swigWallet,
    amount,
    decimals: 6,
  });
  const current = await fetchSwig(swigRpc, swigAddress);
  const wrapped = await getSignInstructions(current, agentRoleId, asSwig([inner]));
  return send(agent, asKit7(wrapped));
}

await report.expectOk("agent moves 3 USDC to itself", () => agentTransfer(agentAta, usdc(3)), link);
await report.expectFail("agent moves 1 USDC to an unknown address must fail", () =>
  agentTransfer(attackerAta, usdc(1)),
);
await report.expectFail("agent moves 3 more to itself (over 5 cap) must fail", () =>
  agentTransfer(agentAta, usdc(3)),
);

// 5. Jupiter through Swig. "destination = self" can't describe a swap (USDC goes to pool
//    vaults), so this role is a program allowlist plus an amount cap: Jupiter + token + ATA
//    programs, at most 5 USDC and 0.01 SOL (rent for the temporary wSOL account).
const swapper = await generateKeyPairSigner();
await cheatcode("surfnet_setAccount", [swapper.address, { lamports: 1_000_000_000 }]);
await cheatcode("surfnet_setAccount", [swigWallet, { lamports: 100_000_000 }]);
swig = await fetchSwig(swigRpc, swigAddress);
await report.expectOk(
  "owner adds swapper role: Jupiter/token/ATA programs, 5 USDC cap",
  async () =>
    send(
      owner,
      asKit7(
        await getAddAuthorityInstructions(
          swig,
          rootRole.id,
          createEd25519AuthorityInfo(swapper.address),
          Actions.set()
            .programLimit({ programId: JUPITER_PROGRAM })
            .programLimit({ programId: TOKEN_PROGRAM_ADDRESS })
            .programLimit({ programId: ASSOCIATED_TOKEN_PROGRAM_ADDRESS })
            .tokenLimit({ mint: USDC, amount: usdc(5) })
            .solLimit({ amount: 10_000_000n })
            .get(),
        ),
      ),
    ),
  link,
);
swig = await fetchSwig(swigRpc, swigAddress);
const swapperRole = swig.findRolesByEd25519SignerPk(swapper.address)[0];
if (!swapperRole) throw new Error("swapper role not found");
const swapperRoleId: number = swapperRole.id;

const build = await report.expectOk(
  "Jupiter /build with the Swig wallet PDA as taker (2 USDC → SOL)",
  () =>
    fetchBuild({
      inputMint: USDC,
      outputMint: WSOL,
      amount: usdc(2),
      taker: swigWallet,
      slippageBps: 100,
      dexes: FORK_DEXES,
    }),
  (b) => `quote: ${b.inAmount} → ${b.outAmount} lamports`,
);
if (!build) report.finish();
async function walletBalances() {
  const { value: lamports } = await forkRpc.getBalance(swigWallet).send();
  const { value } = await forkRpc.getTokenAccountBalance(swigAta).send();
  return { lamports, usdc: BigInt(value.amount) };
}
const beforeSwap = await walletBalances();
await report.expectOk(
  "swapper executes the Jupiter swap signed through Swig",
  async () => {
    const { computeBudget, swap } = swapInstructions(build);
    const wrapped = await getSignInstructions(swig, swapperRoleId, asSwig(swap));
    return send(
      swapper,
      [getSetComputeUnitLimitInstruction({ units: 600_000 }), ...computeBudget, ...asKit7(wrapped)],
      lookupTables(build),
    );
  },
  link,
);
await report.expectOk(
  "Swig wallet: USDC −2 and SOL up",
  async () => {
    const after = await walletBalances();
    if (beforeSwap.usdc - after.usdc !== usdc(2)) {
      throw new Error(`USDC changed by ${beforeSwap.usdc - after.usdc}`);
    }
    if (after.lamports <= beforeSwap.lamports) throw new Error("SOL did not increase");
    return after.lamports - beforeSwap.lamports;
  },
  (gain) => `+${gain} lamports`,
);

// 6. The same role cannot swap past its 5 USDC cap (2 used, 4 more would exceed it).
await report.expectFail("swapper swaps 4 more USDC (over 5 cap) must fail", async () => {
  const more = await fetchBuild({
    inputMint: USDC,
    outputMint: WSOL,
    amount: usdc(4),
    taker: swigWallet,
    slippageBps: 100,
    dexes: FORK_DEXES,
  });
  const { computeBudget, swap } = swapInstructions(more);
  const current = await fetchSwig(swigRpc, swigAddress);
  const wrapped = await getSignInstructions(current, swapperRoleId, asSwig(swap));
  return send(
    swapper,
    [getSetComputeUnitLimitInstruction({ units: 600_000 }), ...computeBudget, ...asKit7(wrapped)],
    lookupTables(more),
  );
});

// 7. The gap: allowlisting the token program (needed for Jupiter's wSOL cleanup) also lets the
//    swapper send USDC anywhere, up to its cap. This is what an injected "send funds to X" does.
async function roleTransfer(roleId: number, feePayer: KeyPairSigner, destination: Address) {
  const inner = getTransferCheckedInstruction({
    source: swigAta,
    mint: USDC,
    destination,
    authority: swigWallet,
    amount: usdc(1),
    decimals: 6,
  });
  const current = await fetchSwig(swigRpc, swigAddress);
  return send(feePayer, asKit7(await getSignInstructions(current, roleId, asSwig([inner]))));
}
await report.expectOk(
  "GAP: swapper role can send 1 USDC to an unknown address (token program allowlisted)",
  () => roleTransfer(swapperRoleId, swapper, attackerAta),
  link,
);

// 8. Stricter role: Jupiter + ATA programs only (no token program). Skip Jupiter's cleanup
//    instruction (the wSOL account stays open), so the swap needs no top-level token call.
const strict = await generateKeyPairSigner();
await cheatcode("surfnet_setAccount", [strict.address, { lamports: 1_000_000_000 }]);
swig = await fetchSwig(swigRpc, swigAddress);
await report.expectOk(
  "owner adds strict role: Jupiter + ATA programs only, 5 USDC cap",
  async () =>
    send(
      owner,
      asKit7(
        await getAddAuthorityInstructions(
          swig,
          rootRole.id,
          createEd25519AuthorityInfo(strict.address),
          Actions.set()
            .programLimit({ programId: JUPITER_PROGRAM })
            .programLimit({ programId: ASSOCIATED_TOKEN_PROGRAM_ADDRESS })
            .tokenLimit({ mint: USDC, amount: usdc(5) })
            .solLimit({ amount: 10_000_000n })
            .get(),
        ),
      ),
    ),
  link,
);
swig = await fetchSwig(swigRpc, swigAddress);
const strictRole = swig.findRolesByEd25519SignerPk(strict.address)[0];
if (!strictRole) throw new Error("strict role not found");
const strictRoleId: number = strictRole.id;
await report.expectOk(
  "strict role swaps 1 USDC → SOL via Jupiter (no cleanup ix)",
  async () => {
    const b = await fetchBuild({
      inputMint: USDC,
      outputMint: WSOL,
      amount: usdc(1),
      taker: swigWallet,
      slippageBps: 100,
      dexes: FORK_DEXES,
    });
    const noCleanup = { ...b, cleanupInstruction: null };
    const { computeBudget, swap } = swapInstructions(noCleanup);
    const current = await fetchSwig(swigRpc, swigAddress);
    const wrapped = await getSignInstructions(current, strictRoleId, asSwig(swap));
    return send(
      strict,
      [getSetComputeUnitLimitInstruction({ units: 600_000 }), ...computeBudget, ...asKit7(wrapped)],
      lookupTables(noCleanup),
    );
  },
  link,
);
await report.expectFail("strict role sends 1 USDC to an unknown address must fail", () =>
  roleTransfer(strictRoleId, strict, attackerAta),
);

report.finish();
