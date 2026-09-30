import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Cluster, ruleCard, sendAndConfirm } from "@syndromi/core";
import {
  ActivityLog,
  type ActivitySink,
  type ApprovalGateway,
  callTool,
  consoleSink,
  executeApprovals,
  fileSink,
  HttpApprovalGateway,
  httpSink,
  LocalApprovalGateway,
  PROMPT_GUARD,
  type ToolCallOptions,
} from "@syndromi/runtime";
import { confirmMainnet, type Env } from "../context.js";
import type { Io } from "../io.js";
import { openAgent, serverFrom } from "../session.js";
import { WATCH_EVERY_MS } from "./run.js";

/** Statuses that mean "nothing was done" (an MCP client may treat them as tool errors). */
const FAILED = new Set(["error", "failed", "not_sent"]);

/** The text an MCP client is told about, so it knows the rules before it calls anything. */
export function instructions(name: string, rules: string[]): string {
  return `You are operating "${name}", a Solana agent wallet on a budget set by its owner, through syndromí.

Owner rules, enforced by a policy signer you cannot bypass:
${rules.map((r) => `- ${r}`).join("\n")}

How acting works:
- You never sign anything. Write tools return a proposal; the policy then executes it, holds it for the owner's approval, or blocks it, and tells you which.
- A blocked or held action is final. Do not retry it with different wording, and never split an action to get under a limit.
${PROMPT_GUARD}- Amounts are in whole tokens (e.g. 3 USDC), and tokens are named by symbol.
- When the allowance is used up, ask the owner once with request-topup.`;
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

/** The MCP server for one agent: its manifest's tools, each call routed through the policy. */
export function buildMcpServer(opts: { name: string; rules: string[]; call: ToolCallOptions }) {
  const { tools } = opts.call;
  const descriptors = tools.describe().map((descriptor, i) => ({
    ...descriptor,
    annotations: { readOnlyHint: tools.tools[i]?.kind === "read", openWorldHint: true },
  }));
  const server = new Server(
    { name: `syndromi-${opts.name}`, version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: instructions(opts.name, opts.rules) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: descriptors }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: input } = request.params;
    const text = await callTool({ id: randomUUID(), name, input }, opts.call);
    return { content: [{ type: "text" as const, text }], isError: isFailure(text) };
  });
  return server;
}

function isFailure(text: string): boolean {
  try {
    const { result } = JSON.parse(text) as { result?: { error?: unknown; status?: string } };
    return Boolean(result?.error) || FAILED.has(result?.status ?? "");
  } catch {
    return false;
  }
}
