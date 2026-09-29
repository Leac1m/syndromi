// Everything a run needs, assembled from a manifest: RPC, prices, policy signer, tool context.
// The agent's real key goes only into the policy signer; tools get a noop signer.
import {
  type Address,
  address,
  createClient,
  createNoopSigner,
  createSolanaRpc,
  isAddress,
  type KeyPairSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import {
  type Cluster,
  createPolicySigner,
  createPriceSource,
  findToken,
  type Manifest,
  mintFor,
  type Network,
  networkOf,
  type PolicySigner,
  type PriceSource,
  rpcUrlFor,
  toPolicy,
} from "@syndromi/core";
import type { ToolContext } from "@syndromi/tools";

export function allowanceMint(manifest: Manifest, network: Network): Address {
  const { mint } = manifest.allowance;
  const token = findToken(mint, network);
  if (token) return mintFor(token, network);
  if (isAddress(mint)) return address(mint);
  throw new Error(`allowance.mint "${mint}" is not a known symbol or an address`);
}

export type PreparedAgent = {
  ctx: ToolContext;
  signer: PolicySigner;
  rpc: ToolContext["rpc"];
};

export function prepareAgent(opts: {
  manifest: Manifest;
  cluster: Cluster;
  agentSigner: KeyPairSigner;
  owner: Address;
  env?: Record<string, string | undefined>;
  prices?: PriceSource;
}): PreparedAgent {
  const env = opts.env ?? process.env;
  const rpcUrl = rpcUrlFor(opts.cluster, env);
  const rpc = createSolanaRpc(rpcUrl);
  const network = networkOf(opts.cluster);
  const prices = opts.prices ?? createPriceSource(env);
  const policy = toPolicy(opts.manifest);
  const agent = opts.agentSigner.address;
  const bag = createClient()
    .use(signer(createNoopSigner(agent)))
    .use(solanaRpc({ rpcUrl }))
    .use(subscriptionsProgram());
  const ctx: ToolContext = {
    agent,
    owner: opts.owner,
    cluster: opts.cluster,
    network,
    rpc,
    prices,
    policy,
    allowanceMint: allowanceMint(opts.manifest, network),
    bag,
    jupiter: env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {},
    ...(opts.manifest.demo?.injection ? { demo: { injection: true } } : {}),
  };
  return {
    ctx,
    rpc,
    signer: createPolicySigner({ signer: opts.agentSigner, policy, prices }),
  };
}
