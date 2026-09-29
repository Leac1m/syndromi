// Day-2 "done when": create an agent, grant it an allowance, and pull, using only
// @syndromi/core, on devnet. The owner is the Solana CLI wallet; the mint is a fresh test mint.
//
// Usage: pnpm demo:core

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, generateKeyPairSigner, lamports } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer, signerFromFile } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { systemProgram } from "@solana-program/system";
import { tokenProgram } from "@solana-program/token";
import {
  ensureSubscriptionAuthority,
  generateAgentKeypair,
  grantAllowance,
  listDelegations,
  loadLocalKeypair,
  pullAllowance,
  revokeAll,
  saveLocalKeypair,
} from "@syndromi/core";
import { explorerTx, heliusUrl } from "./lib/cluster.js";
import { ownerKeypairPath } from "./lib/keys.js";

const rpcUrl = heliusUrl("devnet");
const link = (r: { context: { signature: string } }) => explorerTx(r.context.signature, "devnet");

const owner = await createClient()
  .use(signerFromFile(ownerKeypairPath()))
  .use(solanaRpc({ rpcUrl }))
  .use(systemProgram())
  .use(tokenProgram())
  .use(subscriptionsProgram());
console.log(`owner   ${owner.payer.address}`);

// 1. Create the agent: an encrypted keypair on disk (a temp SYNDROMI_HOME for the demo).
const root = await mkdtemp(join(tmpdir(), "syndromi-demo-"));
const passphrase = "demo passphrase, not for real funds";
const created = await generateAgentKeypair();
const path = await saveLocalKeypair("demo-agent", created, passphrase, { root });
const { signer: agentSigner } = await loadLocalKeypair("demo-agent", passphrase, { root });
console.log(`agent   ${agentSigner.address}  (encrypted at ${path})`);
const agent = createClient()
  .use(signer(agentSigner))
  .use(solanaRpc({ rpcUrl }))
  .use(subscriptionsProgram());

// 2. Fee budget and a test mint standing in for USDC (1,000 in the bag).
console.log(
  `fee     ${link(
    await owner.system.instructions
      .transferSol({
        source: owner.payer,
        destination: agentSigner.address,
        amount: lamports(20_000_000n),
      })
      .sendTransaction(),
  )}`,
);
const mintSigner = await generateKeyPairSigner();
const mint = mintSigner.address;
await owner.token.instructions
  .createMint({ newMint: mintSigner, decimals: 6, mintAuthority: owner.payer.address })
  .sendTransaction();
await owner.token.instructions
  .mintToATA({
    mint,
    owner: owner.payer.address,
    mintAuthority: owner.payer,
    amount: 1_000_000_000n,
    decimals: 6,
  })
  .sendTransaction();
console.log(`mint    ${mint}`);

// 3. Grant a recurring allowance of 10 per day (the Subscription Authority lands first, once).
const setup = await ensureSubscriptionAuthority(owner, mint);
if (setup.length) await owner.sendTransaction(setup);
const grant = await owner.sendTransaction(
  await grantAllowance(owner, {
    agent: agentSigner.address,
    mint,
    amountPerPeriod: 10_000_000n,
    periodSeconds: 86_400,
  }),
);
console.log(`grant   ${link(grant)}`);

// 4. The agent pulls 4.
const pulled = await agent.sendTransaction(
  await pullAllowance(agent, { owner: owner.payer.address, mint, amount: 4_000_000n }),
);
console.log(`pull    ${link(pulled)}`);

// 5. What the dashboard would show.
for (const d of await listDelegations(owner.rpc, owner.payer.address)) {
  if (d.mint !== mint) continue;
  console.log(
    `listed  ${d.kind} for ${d.agent}: ${Number(d.remaining) / 1e6} of ${Number(d.limit) / 1e6} left this period`,
  );
}

// 6. Kill switch for this agent.
await owner.sendTransactions(await revokeAll(owner, { agent: agentSigner.address }));
const left = (await listDelegations(owner.rpc, owner.payer.address)).filter(
  (d) => d.agent === agentSigner.address,
);
console.log(`after   ${left.length} delegations left for the agent`);
if (left.length !== 0) process.exit(1);
