// Shared plumbing for commands: cluster flags, the mainnet guard, the owner wallet, agent files.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Address,
  createClient,
  createKeyPairSignerFromBytes,
  type KeyPairSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { agentDir, type Cluster, type Manifest, parseManifest, rpcUrlFor } from "@syndromi/core";
import { CliError, type Io } from "./io.js";

export type Env = Record<string, string | undefined>;

export function clusterFrom(flags: { fork?: boolean; mainnet?: boolean }): Cluster {
  if (flags.fork && flags.mainnet) throw new CliError("pick one of --fork and --mainnet");
  return flags.mainnet ? "mainnet" : flags.fork ? "fork" : "devnet";
}

/** CLAUDE.md rule 4: mainnet needs the flag and a typed confirmation. No terminal, no mainnet. */
export async function confirmMainnet(cluster: Cluster, io: Io, action: string) {
  if (cluster !== "mainnet") return;
  const answer = await io.ask(
    `This will ${action} on MAINNET with real funds. Type "mainnet" to continue: `,
  );
  if (answer?.trim() !== "mainnet") throw new CliError("mainnet not confirmed; nothing was sent");
}

export async function loadAgentDir(dir: string) {
  const manifestPath = join(resolve(dir), "manifest.yaml");
  const text = await readFile(manifestPath, "utf8").catch(() => {
    throw new CliError(`no manifest.yaml in ${dir}`);
  });
  const parsed = parseManifest(text, manifestPath);
  if (!parsed.ok) throw new CliError(parsed.errors.join("\n"));
  const manifest: Manifest = parsed.manifest;
  const prompt = await readFile(join(resolve(dir), manifest.prompt), "utf8").catch(() => {
    throw new CliError(`prompt file ${manifest.prompt} not found next to the manifest`);
  });
  return { manifest, prompt };
}

export type AgentConfig = { name: string; address: Address; owner?: Address; createdAt: string };

export const agentConfigPath = (name: string, env: Env) =>
  join(agentDir(name, env.SYNDROMI_HOME), "agent.json");

export async function readAgentConfig(name: string, env: Env): Promise<AgentConfig> {
  try {
    return JSON.parse(await readFile(agentConfigPath(name, env), "utf8")) as AgentConfig;
  } catch {
    throw new CliError(`no agent "${name}" yet; run: syndromi init <template or dir>`);
  }
}

export async function writeAgentConfig(config: AgentConfig, env: Env) {
  await writeFile(agentConfigPath(config.name, env), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** The owner (bag) wallet: the Solana CLI keypair, or OWNER_KEYPAIR. */
export async function loadOwner(env: Env): Promise<KeyPairSigner> {
  const path = env.OWNER_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
  const bytes = await readFile(path, "utf8").catch(() => {
    throw new CliError(`owner keypair not found at ${path} (set OWNER_KEYPAIR)`);
  });
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(bytes) as number[]));
}

export function ownerClient(owner: KeyPairSigner, cluster: Cluster, env: Env) {
  return createClient()
    .use(signer(owner))
    .use(solanaRpc({ rpcUrl: rpcUrlFor(cluster, env) }))
    .use(subscriptionsProgram());
}

export async function passphrase(io: Io, env: Env, confirm = false): Promise<string> {
  if (env.SYNDROMI_PASSPHRASE) return env.SYNDROMI_PASSPHRASE;
  const first = await io.secret("Agent key passphrase: ");
  if (first === undefined) throw new CliError("set SYNDROMI_PASSPHRASE or run in a terminal");
  if (confirm && (await io.secret("Repeat passphrase: ")) !== first) {
    throw new CliError("passphrases do not match");
  }
  return first;
}
