import { join } from "node:path";
import { type Cluster, sendAndConfirm } from "@syndromi/core";
import { ActivityLog, consoleSink, executeApprovals, fileSink, httpSink } from "@syndromi/runtime";
import { confirmMainnet, type Env } from "../context.js";
import type { Io } from "../io.js";
import { openAgent, requireServer } from "../session.js";
import { WATCH_EVERY_MS } from "./run.js";

/** `syndromi watch <dir> [--once]`: execute owner approvals only (no LLM runs). */
export async function watch(
  dir: string,
  opts: { cluster: Cluster; once: boolean; server?: string },
  io: Io,
  env: Env,
) {
  const { client } = requireServer(opts.server, env);
  const session = await openAgent(dir, opts, io, env);
  const { manifest, agent, tools, home } = session;
  await confirmMainnet(opts.cluster, io, `execute approvals for ${manifest.name}`);
  await client.register(session.registration);
  const sinks = [
    consoleSink(io.print),
    fileSink(join(home, "activity.jsonl")),
    httpSink(client, manifest.name),
  ];
  const pass = () =>
    executeApprovals({
      client,
      agentName: manifest.name,
      tools,
      signer: agent.signer,
      ctx: agent.ctx,
      log: new ActivityLog(manifest.name, sinks),
      send: (tx) => sendAndConfirm(agent.rpc, tx),
    });
  if (opts.once) return pass();
  io.print(`watching approvals for ${manifest.name} every 5 s (Ctrl+C to stop)`);
  for (let stop = false; !stop; ) {
    await pass().catch((e) => io.print(`watcher: ${(e as Error).message}`));
    stop = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), WATCH_EVERY_MS);
      process.once("SIGINT", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  return undefined;
}
