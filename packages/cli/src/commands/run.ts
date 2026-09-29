import { join } from "node:path";
import { type Cluster, sendAndConfirm } from "@syndromi/core";
import {
  ActivityLog,
  type ActivitySink,
  type ApprovalGateway,
  consoleSink,
  createProvider,
  executeApprovals,
  fileSink,
  HttpApprovalGateway,
  httpSink,
  LocalApprovalGateway,
  runOnce,
  schedule,
} from "@syndromi/runtime";
import { confirmMainnet, type Env } from "../context.js";
import type { Io } from "../io.js";
import { openAgent, serverFrom } from "../session.js";

export const WATCH_EVERY_MS = 5_000;

/**
 * `syndromi run <dir> [--once] [--server <url>]`: run the agent now or on its schedule. With a
 * server, drafts go to Telegram and approved ones are executed by the watcher.
 */
export async function run(
  dir: string,
  opts: { cluster: Cluster; once: boolean; maxSteps?: number; model?: string; server?: string },
  io: Io,
  env: Env,
) {
  const session = await openAgent(dir, opts, io, env);
  const { manifest, agent, tools, home } = session;
  await confirmMainnet(opts.cluster, io, `run agent ${manifest.name}, which may send transactions`);
  if (manifest.runtime === "hosted") {
    io.print(
      `note: ${manifest.name} is a hosted agent; running it locally (deploy arrives on Day 6)`,
    );
  }

  const server = serverFrom(opts.server, env);
  const sinks: ActivitySink[] = [consoleSink(io.print), fileSink(join(home, "activity.jsonl"))];
  let approvals: ApprovalGateway = new LocalApprovalGateway(home);
  if (server) {
    await server.register(session.registration);
    sinks.push(httpSink(server, manifest.name));
    approvals = new HttpApprovalGateway(server, manifest.name);
    io.print(`server  ${opts.server ?? env.SYNDROMI_SERVER_URL} (drafts go to Telegram)`);
  }
  const send = (tx: Parameters<typeof sendAndConfirm>[1]) => sendAndConfirm(agent.rpc, tx);
  const provider = createProvider(manifest, env);

  const once = () =>
    runOnce({
      manifest,
      prompt: session.prompt,
      provider,
      tools,
      signer: agent.signer,
      ctx: agent.ctx,
      log: new ActivityLog(manifest.name, sinks),
      approvals,
      send,
      ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    });
  const attempts = new Map<string, number>();
  const watch = async () => {
    if (!server) return;
    const result = await executeApprovals({
      client: server,
      agentName: manifest.name,
      tools,
      signer: agent.signer,
      ctx: agent.ctx,
      log: new ActivityLog(manifest.name, sinks),
      send,
      attempts,
    });
    return result;
  };

  if (opts.once) {
    await watch(); // anything approved since the last run executes first
    return once();
  }

  const job = schedule(manifest.schedule, once, {
    onError: (error) => io.print(`run failed: ${(error as Error).message}`),
    onSkip: () => io.print("previous run still in progress; skipping this tick"),
  });
  let watching = false;
  const timer = server
    ? setInterval(() => {
        if (watching) return;
        watching = true;
        void watch()
          .catch((e) => io.print(`watcher: ${(e as Error).message}`))
          .finally(() => {
            watching = false;
          });
      }, WATCH_EVERY_MS)
    : undefined;
  io.print(
    `scheduled "${manifest.schedule}"; next run ${job.next()?.toISOString()}` +
      `${server ? "; watching for approvals every 5 s" : ""} (Ctrl+C to stop)`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      job.stop();
      if (timer) clearInterval(timer);
      resolve();
    });
  });
  return undefined;
}
