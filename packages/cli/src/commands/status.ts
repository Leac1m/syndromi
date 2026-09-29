import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Cluster,
  listDelegations,
  syndromiHome,
  tokenByMint,
  toUiAmount,
} from "@syndromi/core";
import { type AgentConfig, type Env, loadOwner, ownerClient } from "../context.js";
import type { Io } from "../io.js";

/** Names for agent addresses, from the local agent configs. */
export async function agentNames(env: Env): Promise<Map<string, string>> {
  const root = join(syndromiHome(env.SYNDROMI_HOME), "agents");
  const names = new Map<string, string>();
  for (const name of await readdir(root).catch(() => [])) {
    try {
      const config = JSON.parse(
        await readFile(join(root, name, "agent.json"), "utf8"),
      ) as AgentConfig;
      names.set(config.address, config.name);
    } catch {}
  }
  return names;
}

/** `syndromi status`: every delegation from the owner's bag, with what is left. */
export async function status(opts: { cluster: Cluster }, io: Io, env: Env) {
  const owner = await loadOwner(env);
  const client = ownerClient(owner, opts.cluster, env);
  const names = await agentNames(env);
  const delegations = await listDelegations(client.rpc, owner.address);
  io.print(`bag owner ${owner.address} (${opts.cluster}): ${delegations.length} delegation(s)`);
  for (const d of delegations) {
    const token = tokenByMint(d.mint);
    const ui = (n: bigint) => toUiAmount(n, token?.decimals ?? 6);
    const when = d.periodEndsAt
      ? `resets ${new Date(Number(d.periodEndsAt) * 1000).toISOString()}`
      : `expires ${new Date(Number(d.expiresAt) * 1000).toISOString()}`;
    io.print(
      `  ${(names.get(d.agent) ?? d.agent).padEnd(14)} ${d.kind.padEnd(9)} ` +
        `${ui(d.remaining)} of ${ui(d.limit)} ${token?.symbol ?? d.mint} left, ${when}`,
    );
  }
  return delegations;
}
