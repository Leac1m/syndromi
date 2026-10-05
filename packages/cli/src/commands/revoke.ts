import { type Cluster, explorerTx, revokeAll, signAndSend } from "@syndromi/core";
import { confirmMainnet, type Env, loadOwner, ownerClient, readAgentConfig } from "../context.js";
import { CliError, type Io } from "../io.js";

const PER_TX = 6;

/** `syndromi revoke --all | --agent <name> [--hard]`: the kill switch. */
export async function revoke(
  opts: { cluster: Cluster; all?: boolean; agent?: string; hard?: boolean },
  io: Io,
  env: Env,
) {
  if (!opts.all && !opts.agent) throw new CliError("pass --all, or --agent <name>");
  await confirmMainnet(opts.cluster, io, "revoke allowances and top-ups");
  const owner = await loadOwner(env);
  const client = ownerClient(owner, opts.cluster, env);
  const agent = opts.agent ? (await readAgentConfig(opts.agent, env)).address : undefined;
  const instructions = await revokeAll(client, {
    ...(agent ? { agent } : {}),
    ...(opts.hard ? { hard: true } : {}),
  });
  if (instructions.length === 0) {
    io.print("nothing to revoke");
    return 0;
  }
  for (let i = 0; i < instructions.length; i += PER_TX) {
    const sig = await signAndSend(client.rpc, owner, instructions.slice(i, i + PER_TX));
    io.print(`revoked ${explorerTx(sig, opts.cluster)}`);
  }
  io.print(
    `done: ${instructions.length} instruction(s)${opts.hard ? ", including token approvals" : ""}`,
  );
  return instructions.length;
}
