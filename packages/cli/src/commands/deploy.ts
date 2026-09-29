// `syndromi deploy <dir> [--owner <address>]`: hand an agent to the server, which creates its key
// (hosted custody) and runs it on the manifest schedule with the same runtime as `syndromi run`.
import { type Address, isAddress } from "@solana/kit";
import type { Cluster } from "@syndromi/core";
import { confirmMainnet, type Env, loadAgentDir, loadOwner } from "../context.js";
import { CliError, type Io } from "../io.js";
import { requireServer } from "../session.js";

export async function deploy(
  dir: string,
  opts: { cluster: Cluster; owner?: string; server?: string },
  io: Io,
  env: Env,
) {
  const { client } = requireServer(opts.server, env);
  const { manifest, prompt } = await loadAgentDir(dir);
  let owner: Address;
  if (opts.owner) {
    if (!isAddress(opts.owner)) throw new CliError(`--owner ${opts.owner} is not a Solana address`);
    owner = opts.owner;
  } else {
    owner = (await loadOwner(env)).address;
  }
  await confirmMainnet(opts.cluster, io, `deploy ${manifest.name} as a hosted agent`);
  const deployed = await client.deploy({
    manifest: { ...manifest, runtime: "hosted" },
    prompt,
    owner,
    cluster: opts.cluster,
  });
  const flag = opts.cluster === "devnet" ? "" : ` --${opts.cluster}`;
  io.print(`deployed ${deployed.name} (hosted) ${deployed.address} on ${deployed.cluster}`);
  io.print(
    opts.cluster === "fork"
      ? `next     syndromi action /actions/fund-agent/${deployed.name}${flag}`
      : `next     fund it in the dashboard, or: syndromi action /actions/fund-agent/${deployed.name}${flag}`,
  );
  return deployed;
}
