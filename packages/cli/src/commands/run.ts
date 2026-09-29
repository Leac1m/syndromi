import { join } from "node:path";
import { agentDir, type Cluster, loadLocalKeypair, sendAndConfirm } from "@syndromi/core";
import {
  ActivityLog,
  consoleSink,
  createProvider,
  fileSink,
  LocalApprovalGateway,
  prepareAgent,
  runOnce,
  schedule,
} from "@syndromi/runtime";
import { createToolset } from "@syndromi/tools";
import { confirmMainnet, type Env, loadAgentDir, passphrase, readAgentConfig } from "../context.js";
import { CliError, type Io } from "../io.js";

/** `syndromi run <dir> [--once]`: run the agent now, or on its manifest schedule. */
export async function run(
  dir: string,
  opts: { cluster: Cluster; once: boolean; maxSteps?: number },
  io: Io,
  env: Env,
) {
  const { manifest, prompt } = await loadAgentDir(dir);
  const config = await readAgentConfig(manifest.name, env);
  if (!config.owner)
    throw new CliError(`agent "${manifest.name}" has no allowance yet; run: syndromi fund ${dir}`);
  await confirmMainnet(opts.cluster, io, `run agent ${manifest.name}, which may send transactions`);
  if (manifest.runtime === "hosted") {
    io.print(
      `note: ${manifest.name} is a hosted agent; running it locally (deploy arrives on Day 6)`,
    );
  }

  const home = agentDir(manifest.name, env.SYNDROMI_HOME);
  const { signer: agentSigner } = await loadLocalKeypair(manifest.name, await passphrase(io, env), {
    root: env.SYNDROMI_HOME,
  });
  const agent = prepareAgent({
    manifest,
    cluster: opts.cluster,
    agentSigner,
    owner: config.owner,
    env,
  });
  const provider = createProvider(manifest, env);
  const tools = createToolset(manifest.tools);
  const approvals = new LocalApprovalGateway(home);
  const sinks = [consoleSink(io.print), fileSink(join(home, "activity.jsonl"))];

  const once = () =>
    runOnce({
      manifest,
      prompt,
      provider,
      tools,
      signer: agent.signer,
      ctx: agent.ctx,
      log: new ActivityLog(manifest.name, sinks),
      approvals,
      send: (tx) => sendAndConfirm(agent.rpc, tx),
      ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    });

  if (opts.once) return once();

  const job = schedule(manifest.schedule, once, {
    onError: (error) => io.print(`run failed: ${(error as Error).message}`),
    onSkip: () => io.print("previous run still in progress; skipping this tick"),
  });
  io.print(
    `scheduled "${manifest.schedule}"; next run ${job.next()?.toISOString()} (Ctrl+C to stop)`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      job.stop();
      resolve();
    });
  });
  return undefined;
}
