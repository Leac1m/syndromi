// Everything a command needs to act as an agent: manifest, prompt, decrypted key, prepared
// runtime context, tools, and (optionally) the approvals server.
import { agentDir, type Cluster, loadLocalKeypair } from "@syndromi/core";
import {
  type AgentRegistration,
  allowanceMint,
  modelOverride,
  prepareAgent,
  ServerClient,
} from "@syndromi/runtime";
import { createToolset } from "@syndromi/tools";
import { type Env, loadAgentDir, passphrase, readAgentConfig } from "./context.js";
import { CliError, type Io } from "./io.js";

export function serverFrom(url: string | undefined, env: Env): ServerClient | undefined {
  const target = url ?? env.SYNDROMI_SERVER_URL;
  if (!target) return undefined;
  const token = env.SYNDROMI_SERVER_TOKEN;
  if (!token)
    throw new CliError("SYNDROMI_SERVER_TOKEN is not set (the server prints how to set it)");
  return new ServerClient({ url: target, token });
}

export function requireServer(
  url: string | undefined,
  env: Env,
): { client: ServerClient; url: string } {
  const client = serverFrom(url, env);
  const target = url ?? env.SYNDROMI_SERVER_URL;
  if (!client || !target)
    throw new CliError("no server: pass --server <url> or set SYNDROMI_SERVER_URL");
  return { client, url: target.replace(/\/+$/, "") };
}

export async function openAgent(
  dir: string,
  opts: { cluster: Cluster; model?: string },
  io: Io,
  env: Env,
) {
  const loaded = await loadAgentDir(dir);
  // --model swaps the model for this run only (e.g. nvidia:<id>, gemini:<id>).
  const manifest = opts.model
    ? { ...loaded.manifest, ...modelOverride(opts.model) }
    : loaded.manifest;
  const config = await readAgentConfig(manifest.name, env);
  const owner = config.owner;
  if (!owner)
    throw new CliError(`agent "${manifest.name}" has no allowance yet; run: syndromi fund ${dir}`);
  const { signer: agentSigner } = await loadLocalKeypair(manifest.name, await passphrase(io, env), {
    root: env.SYNDROMI_HOME,
  });
  const agent = prepareAgent({ manifest, cluster: opts.cluster, agentSigner, owner, env });
  const registration: AgentRegistration = {
    name: manifest.name,
    address: agentSigner.address,
    owner,
    cluster: opts.cluster,
    allowanceMint: allowanceMint(manifest, agent.ctx.network),
    rules: {
      maxTxUsd: manifest.permissions.max_tx_usd,
      approveAboveUsd: manifest.permissions.approve_above_usd,
      destinations: manifest.permissions.destinations,
      programs: manifest.permissions.programs,
    },
  };
  return {
    manifest,
    prompt: loaded.prompt,
    agent,
    tools: createToolset(manifest.tools),
    home: agentDir(manifest.name, env.SYNDROMI_HOME),
    registration,
  };
}
