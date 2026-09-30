import { access, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isAddress } from "@solana/kit";
import { agentDir, type Cluster, generateAgentKeypair, saveLocalKeypair } from "@syndromi/core";
import {
  agentConfigPath,
  type Env,
  loadAgentDir,
  passphrase,
  writeAgentConfig,
} from "../context.js";
import { CliError, type Io } from "../io.js";
import { registrationOf, serverFrom } from "../session.js";
import { claudeAddCommand } from "./mcp.js";

export const TEMPLATES_DIR = new URL("../../../../templates/", import.meta.url).pathname;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * `syndromi init <template|dir> [--dir <path>]`: copy a template (or use an existing agent
 * directory in place) and create the agent's encrypted keypair.
 */
export async function init(
  target: string,
  opts: { dir?: string; server?: string; owner?: string; cluster?: Cluster },
  io: Io,
  env: Env,
  templatesDir = TEMPLATES_DIR,
) {
  let dir: string;
  // --dir only makes sense for a copy, so with it a template name wins over a same-named folder.
  const isTemplate = await exists(join(templatesDir, target, "manifest.yaml"));
  if (!(opts.dir && isTemplate) && (await exists(join(target, "manifest.yaml")))) {
    dir = target;
  } else if (isTemplate) {
    dir = opts.dir ?? target;
    if (await exists(dir)) throw new CliError(`${dir} already exists; pass --dir <new path>`);
    await cp(join(templatesDir, target), dir, { recursive: true });
    io.print(`copied template ${target} → ${resolve(dir)}`);
  } else {
    throw new CliError(
      `"${target}" is neither an agent directory nor a template in ${templatesDir}`,
    );
  }

  const { manifest } = await loadAgentDir(dir);
  if (await exists(agentConfigPath(manifest.name, env))) {
    throw new CliError(
      `agent "${manifest.name}" already exists in ${agentDir(manifest.name, env.SYNDROMI_HOME)}`,
    );
  }
  const secret = await passphrase(io, env, true);
  const keypair = await generateAgentKeypair();
  const path = await saveLocalKeypair(manifest.name, keypair, secret, { root: env.SYNDROMI_HOME });
  const owner = opts.owner && isAddress(opts.owner) ? opts.owner : undefined;
  if (opts.owner && !owner) throw new CliError(`--owner ${opts.owner} is not a Solana address`);
  await writeAgentConfig(
    {
      name: manifest.name,
      address: keypair.signer.address,
      ...(owner ? { owner } : {}),
      createdAt: new Date().toISOString(),
    },
    env,
  );
  io.print(`agent   ${manifest.name}  ${keypair.signer.address}`);
  io.print(`key     ${path} (encrypted)`);
  const server = serverFrom(opts.server, env);
  if (server && owner) {
    await server.register(
      registrationOf(manifest, keypair.signer.address, owner, opts.cluster ?? "devnet"),
    );
    io.print(`server  registered; fund it from the dashboard (or: syndromi fund ${dir})`);
  } else {
    io.print(`next    syndromi fund ${dir} [--fork]`);
  }
  if (manifest.runtime === "external") {
    io.print("");
    io.print("Connect it to Claude Code (or any MCP client) once it is funded:");
    io.print(
      `  ${claudeAddCommand({ name: manifest.name, dir, ...(opts.server ? { server: opts.server } : {}), ...(opts.cluster ? { cluster: opts.cluster } : {}) })}`,
    );
  }
  return { dir, name: manifest.name, address: keypair.signer.address };
}
