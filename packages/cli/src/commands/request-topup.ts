import { type Cluster, toBaseUnits, tokenByMint } from "@syndromi/core";
import { type Env, loadAgentDir, readAgentConfig } from "../context.js";
import { CliError, type Io } from "../io.js";
import { registrationOf, requireServer } from "../session.js";

/**
 * `syndromi request-topup <dir> --amount n --reason "…"`: file a top-up request for an agent
 * (operators and tests; agents normally use the request-topup tool).
 */
export async function requestTopUp(
  dir: string,
  opts: { cluster: Cluster; amount?: string; reason?: string; server?: string },
  io: Io,
  env: Env,
) {
  const amount = Number(opts.amount);
  if (!(amount > 0)) throw new CliError("pass --amount <tokens> (greater than 0)");
  if (!opts.reason) throw new CliError('pass --reason "<why the agent needs it>"');
  const { client } = requireServer(opts.server, env);
  const { manifest } = await loadAgentDir(dir);
  const config = await readAgentConfig(manifest.name, env);
  if (!config.owner)
    throw new CliError(`agent "${manifest.name}" has no allowance yet; run: syndromi fund ${dir}`);
  const registration = registrationOf(manifest, config.address, config.owner, opts.cluster);
  const mint = registration.allowanceMint;
  const decimals = tokenByMint(mint)?.decimals ?? 6;
  await client.register(registration);
  const saved = await client.requestTopUp(manifest.name, {
    mint,
    amount: toBaseUnits(amount, decimals),
    reason: opts.reason,
  });
  io.print(`requested top-up ${saved.id}: ${amount} for ${manifest.name} (check Telegram)`);
  return saved;
}
