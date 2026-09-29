// Day-1 spike: prove the Subscriptions program covers what syndromí needs, on devnet.
// Owner = Solana CLI wallet (the "bag"). Agent = fresh keypair each run.
// Recurring delegation = the agent's allowance; fixed delegation = an approved top-up;
// revokeDelegation = the kill switch.
//
// Usage: pnpm spike:delegation [--wait-reset]

import { createClient, generateKeyPairSigner, lamports } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer, signerFromFile } from "@solana/kit-plugin-signer";
import {
  fetchMaybeSubscriptionAuthority,
  findFixedDelegationPda,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  subscriptionsProgram,
} from "@solana/subscriptions";
import { systemProgram } from "@solana-program/system";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
  tokenProgram,
} from "@solana-program/token";
import { explorerTx, heliusUrl } from "./lib/cluster.js";
import { ownerKeypairPath } from "./lib/keys.js";
import { Report } from "./lib/report.js";

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const tokens = (n: number) => BigInt(n) * UNIT;
const PERIOD_S = 60n;
const FEE_BUDGET = lamports(20_000_000n); // 0.02 SOL
const waitReset = process.argv.includes("--wait-reset");

const rpcUrl = heliusUrl("devnet");
const report = new Report();
const tx = (result: { context: { signature: string } }) =>
  explorerTx(result.context.signature, "devnet");

const owner = await createClient()
  .use(signerFromFile(ownerKeypairPath()))
  .use(solanaRpc({ rpcUrl }))
  .use(systemProgram())
  .use(tokenProgram())
  .use(subscriptionsProgram());

const agentSigner = await generateKeyPairSigner();
const agent = createClient()
  .use(signer(agentSigner))
  .use(solanaRpc({ rpcUrl }))
  .use(subscriptionsProgram());

console.log(`owner  ${owner.payer.address}`);
console.log(`agent  ${agentSigner.address}\n`);

// 1. Fee budget: the owner funds the agent's SOL for fees and rent.
await report.expectOk(
  "owner sends agent a 0.02 SOL fee budget",
  () =>
    owner.system.instructions
      .transferSol({ source: owner.payer, destination: agentSigner.address, amount: FEE_BUDGET })
      .sendTransaction(),
  tx,
);

// 2. A fresh 6-decimal test mint stands in for USDC; the owner holds 1,000.
const mintSigner = await generateKeyPairSigner();
const tokenMint = mintSigner.address;
await report.expectOk(
  "create tUSDC test mint",
  () =>
    owner.token.instructions
      .createMint({ newMint: mintSigner, decimals: DECIMALS, mintAuthority: owner.payer.address })
      .sendTransaction(),
  (r) => `${tokenMint} ${tx(r)}`,
);
await report.expectOk(
  "mint 1,000 tUSDC to the owner (the bag)",
  () =>
    owner.token.instructions
      .mintToATA({
        mint: tokenMint,
        owner: owner.payer.address,
        mintAuthority: owner.payer,
        amount: tokens(1000),
        decimals: DECIMALS,
      })
      .sendTransaction(),
  tx,
);

const [ownerAta] = await findAssociatedTokenPda({
  mint: tokenMint,
  owner: owner.payer.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const [agentAta] = await findAssociatedTokenPda({
  mint: tokenMint,
  owner: agentSigner.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
await report.expectOk(
  "agent creates its own tUSDC account (paid from fee budget)",
  async () =>
    agent.sendTransaction([
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: agentSigner,
        owner: agentSigner.address,
        mint: tokenMint,
      }),
    ]),
  tx,
);

// 3. Subscription Authority for (owner, mint): created once, gates every pull.
const [subscriptionAuthority] = await findSubscriptionAuthorityPda({
  user: owner.payer.address,
  tokenMint,
});
const existing = await fetchMaybeSubscriptionAuthority(owner.rpc, subscriptionAuthority);
if (!existing.exists) {
  await report.expectOk(
    "init Subscription Authority for the bag",
    () =>
      owner.subscriptions.instructions
        .initSubscriptionAuthority({
          tokenMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          userAta: ownerAta,
        })
        .sendTransaction(),
    tx,
  );
}

const pull = (
  kind: "recurring" | "fixed",
  delegationPda: typeof subscriptionAuthority,
  amount: bigint,
) => {
  const input = {
    delegator: owner.payer.address,
    delegatorAta: ownerAta,
    tokenMint,
    delegationPda,
    amount,
    receiverAta: agentAta,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  };
  const ix =
    kind === "recurring"
      ? agent.subscriptions.instructions.transferRecurring(input)
      : agent.subscriptions.instructions.transferFixed(input);
  return ix.sendTransaction();
};

// 4. Recurring delegation: 10 tUSDC per 60s period, starts when it lands, expires in a day.
const now = BigInt(Math.floor(Date.now() / 1000));
const [recurringPda] = await findRecurringDelegationPda({
  subscriptionAuthority,
  delegator: owner.payer.address,
  delegatee: agentSigner.address,
  nonce: 0n,
});
await report.expectOk(
  "owner grants a recurring allowance: 10 tUSDC / 60s",
  () =>
    owner.subscriptions.instructions
      .createRecurringDelegation({
        tokenMint,
        delegatee: agentSigner.address,
        nonce: 0n,
        amountPerPeriod: tokens(10),
        periodLengthS: PERIOD_S,
        startTs: 0n,
        expiryTs: now + 86_400n,
      })
      .sendTransaction(),
  tx,
);

// 5. Pull within the limit, then over it.
await report.expectOk(
  "agent pulls 6 tUSDC (within limit)",
  () => pull("recurring", recurringPda, tokens(6)),
  tx,
);
await report.expectFail("agent pulls 6 more (over the 10/period limit) must fail", () =>
  pull("recurring", recurringPda, tokens(6)),
);
if (waitReset) {
  console.log(`   waiting ${PERIOD_S + 5n}s for the period to reset...`);
  await new Promise((r) => setTimeout(r, Number(PERIOD_S + 5n) * 1000));
  await report.expectOk(
    "after reset, agent pulls 6 tUSDC",
    () => pull("recurring", recurringPda, tokens(6)),
    tx,
  );
}

// 6. Kill switch: revoke, then any pull fails.
await report.expectOk(
  "owner revokes the recurring delegation",
  () =>
    owner.subscriptions.instructions
      .revokeDelegation({ authority: owner.payer, delegationAccount: recurringPda })
      .sendTransaction(),
  tx,
);
await report.expectFail("agent pulls 1 tUSDC after revoke must fail", () =>
  pull("recurring", recurringPda, tokens(1)),
);

// 7. Fixed delegation = an approved one-time top-up of 5 tUSDC.
const [fixedPda] = await findFixedDelegationPda({
  subscriptionAuthority,
  delegator: owner.payer.address,
  delegatee: agentSigner.address,
  nonce: 1n,
});
await report.expectOk(
  "owner approves a fixed top-up: 5 tUSDC, expires in a day",
  () =>
    owner.subscriptions.instructions
      .createFixedDelegation({
        tokenMint,
        delegatee: agentSigner.address,
        nonce: 1n,
        amount: tokens(5),
        expiryTs: now + 86_400n,
      })
      .sendTransaction(),
  tx,
);
await report.expectOk(
  "agent pulls 3 tUSDC from the top-up",
  () => pull("fixed", fixedPda, tokens(3)),
  tx,
);
await report.expectFail("agent pulls 3 more (over the 5 cap) must fail", () =>
  pull("fixed", fixedPda, tokens(3)),
);
await report.expectOk(
  "owner revokes the fixed delegation",
  () =>
    owner.subscriptions.instructions
      .revokeDelegation({ authority: owner.payer, delegationAccount: fixedPda })
      .sendTransaction(),
  tx,
);

// 8. The agent's balance should be exactly what it was allowed to pull.
const expected = tokens(6 + (waitReset ? 6 : 0) + 3);
await report.expectOk(
  `agent balance is ${expected / UNIT} tUSDC`,
  async () => {
    const account = await fetchToken(owner.rpc, agentAta);
    if (account.data.amount !== expected) {
      throw new Error(`balance is ${account.data.amount}, expected ${expected}`);
    }
    return account.data.amount;
  },
  (amount) => `${amount} base units`,
);

report.finish();
