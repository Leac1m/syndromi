import { lamports } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type Cluster,
  ensureSubscriptionAuthority,
  explorerTx,
  grantAllowance,
  listDelegations,
  networkOf,
  periodSeconds,
  SURFPOOL_URL,
  signAndSend,
  toBaseUnits,
  tokenByMint,
  toUiAmount,
} from "@syndromi/core";
import { allowanceMint } from "@syndromi/runtime";
import {
  confirmMainnet,
  type Env,
  loadAgentDir,
  loadOwner,
  ownerClient,
  readAgentConfig,
  writeAgentConfig,
} from "../context.js";
import type { Io } from "../io.js";

/**
 * `syndromi fund <dir>`: the owner side of creating an agent. Sends the fee budget, sets up the
 * bag's Subscription Authority for the mint (once), and grants the recurring allowance.
 */
export async function fund(dir: string, opts: { cluster: Cluster }, io: Io, env: Env) {
  const { cluster } = opts;
  const { manifest } = await loadAgentDir(dir);
  const config = await readAgentConfig(manifest.name, env);
  await confirmMainnet(cluster, io, `fund agent ${manifest.name} from your wallet`);

  const owner = await loadOwner(env);
  const client = ownerClient(owner, cluster, env);
  const mint = allowanceMint(manifest, networkOf(cluster));
  const token = tokenByMint(mint);
  const decimals = token?.decimals ?? 6;
  const amountPerPeriod = toBaseUnits(manifest.allowance.amount, decimals);
  const link = (sig: string) => explorerTx(sig, cluster);
  io.print(`owner   ${owner.address} (${cluster})`);

  const [bag] = await findAssociatedTokenPda({
    owner: owner.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const bagBalance = async () =>
    client.rpc
      .getTokenAccountBalance(bag)
      .send()
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n);

  if (cluster === "fork") {
    // Surfpool cheatcodes: give the owner SOL and a bag of the allowance token to work with.
    const { value: sol } = await client.rpc.getBalance(owner.address).send();
    if (sol < 1_000_000_000n)
      await cheatcode("surfnet_setAccount", [owner.address, { lamports: 5_000_000_000 }]);
    if ((await bagBalance()) < amountPerPeriod * 10n) {
      await cheatcode("surfnet_setTokenAccount", [
        owner.address,
        mint,
        { amount: Number(amountPerPeriod * 10n) },
      ]);
    }
  }
  const held = await bagBalance();
  io.print(`wallet  ${toUiAmount(held, decimals)} ${token?.symbol ?? mint}`);
  if (held < amountPerPeriod) {
    io.print(
      `warning your wallet holds less than one period's allowance; pulls will fail until it has more`,
    );
  }

  // Fee budget: top the agent up to fee_budget.sol for fees and token-account rent.
  const budget = toBaseUnits(manifest.fee_budget.sol, 9);
  const { value: agentSol } = await client.rpc.getBalance(config.address).send();
  if (agentSol < budget) {
    const sig = await signAndSend(client.rpc, owner, [
      getTransferSolInstruction({
        source: owner,
        destination: config.address,
        amount: lamports(budget - agentSol),
      }),
    ]);
    io.print(`fee     ${toUiAmount(budget - agentSol, 9)} SOL → agent  ${link(sig)}`);
  } else {
    io.print(`fee     agent already holds ${toUiAmount(agentSol, 9)} SOL`);
  }

  const setup = await ensureSubscriptionAuthority(client, mint);
  if (setup.length) io.print(`setup   ${link(await signAndSend(client.rpc, owner, setup))}`);

  const existing = (await listDelegations(client.rpc, owner.address)).find(
    (d) => d.agent === config.address && d.kind === "allowance" && d.mint === mint,
  );
  if (existing) {
    io.print(
      `grant   allowance exists: ${toUiAmount(existing.limit, decimals)} per period, ` +
        `${toUiAmount(existing.remaining, decimals)} left (revoke to change it)`,
    );
  } else {
    const grant = await grantAllowance(client, {
      agent: config.address,
      mint,
      amountPerPeriod,
      periodSeconds: periodSeconds(manifest.allowance.period),
    });
    const sig = await signAndSend(client.rpc, owner, grant);
    io.print(
      `grant   ${manifest.allowance.amount} ${token?.symbol ?? "tokens"} ${manifest.allowance.period}  ${link(sig)}`,
    );
  }

  await writeAgentConfig({ ...config, owner: owner.address }, env);
  io.print(`next    syndromi run ${dir} --once${cluster === "devnet" ? "" : ` --${cluster}`}`);
}

async function cheatcode(method: string, params: unknown[]) {
  const res = await fetch(SURFPOOL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
}
