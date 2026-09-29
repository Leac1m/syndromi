import { access, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentDir, generateAgentKeypair, saveLocalKeypair } from "@syndromi/core";
import {
  agentConfigPath,
  type Env,
  loadAgentDir,
  passphrase,
  writeAgentConfig,
} from "../context.js";
import { CliError, type Io } from "../io.js";

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
  opts: { dir?: string },
  io: Io,
  env: Env,
  templatesDir = TEMPLATES_DIR,
) {
  let dir: string;
  if (await exists(join(target, "manifest.yaml"))) {
    dir = target;
  } else if (await exists(join(templatesDir, target, "manifest.yaml"))) {
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
  await writeAgentConfig(
    { name: manifest.name, address: keypair.signer.address, createdAt: new Date().toISOString() },
    env,
  );
  io.print(`agent   ${manifest.name}  ${keypair.signer.address}`);
  io.print(`key     ${path} (encrypted)`);
  io.print(`next    syndromi fund ${dir} [--fork]`);
  return { dir, name: manifest.name, address: keypair.signer.address };
}
