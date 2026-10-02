import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Cluster, ruleCard, sendAndConfirm } from "@syndromi/core";
import {
  ActivityLog,
  type ActivitySink,
  type ApprovalGateway,
  buildMcpServer,
  consoleSink,
  executeApprovals,
  fileSink,
  HttpApprovalGateway,
  httpSink,
  LocalApprovalGateway,
  type ToolCallOptions,
} from "@syndromi/runtime";
import { confirmMainnet, type Env } from "../context.js";
import type { Io } from "../io.js";
import { openAgent, serverFrom } from "../session.js";
import { WATCH_EVERY_MS } from "./run.js";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

/** The one-liner that registers an agent with Claude Code (the passphrase and token stay yours). */
export function claudeAddCommand(opts: {
  name: string;
  dir: string;
  server?: string;
  cluster?: Cluster;
}) {
  const flags = [
    opts.server ? `--server ${opts.server}` : "",
    opts.cluster && opts.cluster !== "devnet" ? `--${opts.cluster}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const env = `-e SYNDROMI_PASSPHRASE=<your key passphrase>${opts.server ? " -e SYNDROMI_SERVER_TOKEN=<from .env>" : ""}`;
  return `claude mcp add syndromi-${opts.name} ${env} -- pnpm --silent --dir ${REPO_ROOT} syndromi mcp ${resolve(opts.dir)}${flags ? ` ${flags}` : ""}`;
}

/**
 * `syndromi mcp <dir> [--server <url>]`: serve the agent's tools over MCP (stdio), so any MCP
 * client can act as the agent. Every call takes the same path as the agent loop's: tool, policy
 * signer, then send, draft for the owner, or block. The client never holds a key.
 *
 * stdout is the protocol, so all output goes to stderr. The key passphrase comes from
 * SYNDROMI_PASSPHRASE; mainnet needs `--mainnet` plus SYNDROMI_CONFIRM_MAINNET=mainnet.
 */
export async function mcp(
  dir: string,
  opts: { cluster: Cluster; server?: string },
  _io: Io,
  env: Env,
) {
  const io: Io = {
    print: (line) => console.error(line),
    ask: async () => env.SYNDROMI_CONFIRM_MAINNET,
    secret: async () => undefined,
  };
  const session = await openAgent(dir, opts, io, env);
  const { manifest, agent, tools, home } = session;
  await confirmMainnet(opts.cluster, io, `let an MCP client operate ${manifest.name}`);

  const server = serverFrom(opts.server, env);
  const sinks: ActivitySink[] = [consoleSink(io.print), fileSink(join(home, "activity.jsonl"))];
  let approvals: ApprovalGateway = new LocalApprovalGateway(home);
  if (server) {
    await server.register(session.registration);
    sinks.push(httpSink(server, manifest.name));
    approvals = new HttpApprovalGateway(server, manifest.name);
  }
  const send = (tx: Parameters<typeof sendAndConfirm>[1]) => sendAndConfirm(agent.rpc, tx);
  const log = new ActivityLog(manifest.name, sinks);
  const callOptions: ToolCallOptions = {
    tools,
    signer: agent.signer,
    ctx: agent.ctx,
    log,
    approvals,
    send,
  };

  const mcpServer = buildMcpServer({
    name: manifest.name,
    rules: ruleCard(manifest),
    guidance: session.prompt,
    call: callOptions,
  });

  // Approved drafts and top-ups execute here, as they do under `syndromi run`.
  const attempts = new Map<string, number>();
  let watching = false;
  const timer = server
    ? setInterval(() => {
        if (watching) return;
        watching = true;
        void executeApprovals({
          client: server,
          agentName: manifest.name,
          tools,
          signer: agent.signer,
          ctx: agent.ctx,
          log,
          send,
          attempts,
        })
          .catch((e) => io.print(`watcher: ${(e as Error).message}`))
          .finally(() => {
            watching = false;
          });
      }, WATCH_EVERY_MS)
    : undefined;

  const closed = new Promise<void>((resolve) => {
    mcpServer.onclose = () => {
      if (timer) clearInterval(timer);
      resolve();
    };
  });
  await mcpServer.connect(new StdioServerTransport());
  io.print(
    `syndromi MCP server for ${manifest.name} on ${opts.cluster}${server ? " (approvals via the server)" : ""}`,
  );
  await closed;
}
