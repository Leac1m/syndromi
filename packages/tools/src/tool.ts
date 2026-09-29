// The tool contract: an MCP-compatible shape (name, description, inputSchema) plus a permission
// kind. Read tools return data. Write tools return an UNSIGNED proposal (or an approval request);
// they never see a signing key. The runtime hands proposals to the policy signer.
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import type {
  BagClient,
  Cluster,
  Network,
  Policy,
  PriceSource,
  Proposal,
  ToolName,
} from "@syndromi/core";
import { z } from "zod";

export type ToolKind = "read" | "write";

export type ToolContext = {
  agent: Address;
  /** The bag owner the agent pulls its allowance from. */
  owner: Address;
  cluster: Cluster;
  network: Network;
  rpc: Rpc<SolanaRpcApi>;
  prices: PriceSource;
  policy: Policy;
  /** Mint of the agent's allowance on this network. */
  allowanceMint: Address;
  /** Agent-side subscriptions client whose payer is a noop signer (tools never hold keys). */
  bag: BagClient;
  jupiter?: { apiKey?: string; fetch?: typeof fetch };
};

/** An owner-approval request that is not a transaction, e.g. a top-up. */
export type ApprovalRequest = {
  kind: "topup";
  mint: Address;
  amount: bigint;
  reason: string;
};

export type ToolResult =
  | { type: "data"; data: unknown }
  | {
      type: "proposal";
      proposal: Proposal;
      summary: string;
      /** Set when simulation failed; the policy still decides, but nothing will be sent. */
      simulationError?: string;
    }
  | { type: "request"; request: ApprovalRequest; summary: string };

export type ToolOutcome = ToolResult | { type: "error"; error: string };

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: ToolName;
  description: string;
  kind: ToolKind;
  input: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
};

/** Keeps each tool's input type while letting the registry hold them uniformly. */
export const defineTool = <S extends z.ZodType>(tool: Tool<S>): Tool => tool as unknown as Tool;

/** The MCP `tools/list` shape. */
export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function describe(tool: Tool): ToolDescriptor {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<
    string,
    unknown
  >;
  return { name: tool.name, description: tool.description, inputSchema };
}
