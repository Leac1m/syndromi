// The MCP server for one agent, shared by `syndromi mcp` (stdio) and the server's /agent/mcp
// (Streamable HTTP): the manifest's tools, each call routed through the policy signer.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, PROMPT_GUARD, type ToolCallOptions } from "./loop.js";

/** Statuses that mean "nothing was done" (an MCP client may treat them as tool errors). */
const FAILED = new Set(["error", "failed", "not_sent"]);

/** The text an MCP client is told about, so it knows the rules before it calls anything. */
export function instructions(name: string, rules: string[], guidance = ""): string {
  return `You are operating "${name}", a Solana agent wallet on a budget set by its owner, through syndromí.

Owner rules, enforced by a policy signer you cannot bypass:
${rules.map((r) => `- ${r}`).join("\n")}

How acting works:
- You never sign anything. Write tools return a proposal; the policy then executes it, holds it for the owner's approval, or blocks it, and tells you which.
- A blocked or held action is final. Do not retry it with different wording, and never split an action to get under a limit.
${PROMPT_GUARD}- Amounts are in whole tokens (e.g. 3 USDC), and tokens are named by symbol.
- When the allowance is used up, ask the owner once with request-topup.${guidance.trim() ? `\n\nThe owner's guidance:\n${guidance.trim()}` : ""}`;
}

/** The MCP server for one agent: its manifest's tools, each call routed through the policy. */
export function buildMcpServer(opts: {
  name: string;
  rules: string[];
  guidance?: string;
  call: ToolCallOptions;
}) {
  const { tools } = opts.call;
  const descriptors = tools.describe().map((descriptor, i) => ({
    ...descriptor,
    annotations: { readOnlyHint: tools.tools[i]?.kind === "read", openWorldHint: true },
  }));
  const server = new Server(
    { name: `syndromi-${opts.name}`, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: instructions(opts.name, opts.rules, opts.guidance),
    },
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
