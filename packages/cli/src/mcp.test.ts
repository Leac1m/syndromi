import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateKeyPairSigner, type Signature, type Transaction } from "@solana/kit";
import { createPolicySigner } from "@syndromi/core";
import { ActivityLog, LocalApprovalGateway, memorySink } from "@syndromi/runtime";
import { createToolset } from "@syndromi/tools";
import { fakeContext } from "@syndromi/tools/testing";
import { describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "./commands/mcp.js";

const ATTACKER = "AhLo5HbFDsWtnC4EjkUqmyUPHNpYy4sxTVtH1Tz8MMPS";

async function connect(extra: { guidance?: string } = {}) {
  const agent = await generateKeyPairSigner();
  const ctx = await fakeContext({ agent: agent.address });
  const sink = memorySink();
  const send = vi.fn(async (_t: Transaction) => "sig1" as Signature);
  const signer = createPolicySigner({ signer: agent, policy: ctx.policy, prices: ctx.prices });
  const server = buildMcpServer({
    name: "dca-agent",
    rules: ["Funds may only go to its own wallet."],
    ...extra,
    call: {
      tools: createToolset(["balances", "propose-tx", "request-topup"]),
      signer,
      ctx,
      log: new ActivityLog("dca-agent", [sink]),
      approvals: new LocalApprovalGateway(await mkdtemp(join(tmpdir(), "syndromi-mcp-"))),
      send,
    },
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, send, sink };
}

const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("syndromi MCP server", () => {
  it("tells the client the owner's rules and lists only the manifest's tools", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain("Funds may only go to its own wallet.");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["balances", "propose-tx", "request-topup"]);
    expect(tools.find((t) => t.name === "balances")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "propose-tx")?.annotations?.readOnlyHint).toBe(false);
  });

  it("adds the owner's guidance to the instructions when there is some", async () => {
    const { client } = await connect({ guidance: "Always quote before you swap." });
    expect(client.getInstructions()).toMatch(
      /The owner's guidance:\nAlways quote before you swap\./,
    );
    const plain = await connect();
    expect(plain.client.getInstructions()).not.toContain("guidance");
  });

  it("blocks a transfer to an unknown address: nothing is signed or sent", async () => {
    const { client, send, sink } = await connect();
    const result = await client.callTool({
      name: "propose-tx",
      arguments: { token: "USDC", to: ATTACKER, amount: 2 },
    });
    expect(textOf(result)).toContain('"status":"blocked"');
    expect(result.isError).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(sink.events.some((e) => e.type === "blocked")).toBe(true);
  });

  it("refuses a tool the manifest did not enable, as an error", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "jupiter-swap", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not enabled");
  });

  it("turns a top-up request into an owner request, not a transaction", async () => {
    const { client, send } = await connect();
    const result = await client.callTool({
      name: "request-topup",
      arguments: { amount: 3, reason: "allowance used up" },
    });
    expect(textOf(result)).toContain("requested");
    expect(send).not.toHaveBeenCalled();
  });
});
