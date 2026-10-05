// The owner's AI reaching a server-held agent: tokens, the HTTP tool door, remote MCP, limits.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Address, generateKeyPairSigner, type Signature, type Transaction } from "@solana/kit";
import { createPolicySigner } from "@syndromi/core";
import { ActivityLog, LocalApprovalGateway } from "@syndromi/runtime";
import { createToolset } from "@syndromi/tools";
import { fakeContext } from "@syndromi/tools/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLimits } from "./agent-api.js";
import { createApp, listen } from "./app.js";
import { createContext, type ServerContext } from "./context.js";
import { type AgentRecord, Store } from "./db.js";
import { createAgentToken } from "./tokens.js";

const ATTACKER = "AhLo5HbFDsWtnC4EjkUqmyUPHNpYy4sxTVtH1Tz8MMPS";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TOOLS = ["balances", "propose-tx", "request-topup"] as const;

let ctx: ServerContext;
let app: ReturnType<typeof createApp>;
let agent: AgentRecord;
let secret: string;
let tokenId: string;
let send: ReturnType<typeof vi.fn>;
let events: Record<string, unknown>[];
let viaSeen: { via: string; token: string }[];
const closers: (() => void)[] = [];

async function setup(opts: { limits?: Partial<AgentLimits>; publicUrl?: string } = {}) {
  const owner = (await generateKeyPairSigner()).address;
  const agentSigner = await generateKeyPairSigner();
  ctx = createContext(new Store(":memory:"), {
    publicUrl: opts.publicUrl ?? "http://localhost:8787",
    token: "admin-token",
    env: {},
    draftTtlMs: 60_000,
    topUpTtlMs: 60_000,
    dashboardOrigins: ["http://localhost:3000"],
    ...(opts.limits ? { agentLimits: opts.limits } : {}),
  });
  agent = {
    name: "mcp-agent",
    address: agentSigner.address,
    owner,
    cluster: "devnet",
    allowanceMint: USDC,
    runtime: "external",
    custody: "server",
    allowance: { mint: "USDC", amount: 5, period: "weekly" },
    feeBudgetSol: 0.02,
    rules: { maxTxUsd: 10, approveAboveUsd: 5, destinations: ["self"], programs: ["jupiter"] },
    registeredAt: new Date().toISOString(),
    manifest: { name: "mcp-agent", tools: [...TOOLS] },
    prompt: "Quote before you swap.",
  };
  await ctx.store.upsertAgent(agent);

  const toolCtx = await fakeContext({ agent: agentSigner.address });
  send = vi.fn(async (_t: Transaction) => "sig1" as Signature);
  events = [];
  viaSeen = [];
  const approvals = new LocalApprovalGateway(await mkdtemp(join(tmpdir(), "syndromi-agent-api-")));
  ctx.hosted = {
    scan: () => undefined,
    runNow: () => false,
    remote: async (_name, via) => {
      viaSeen.push(via);
      return {
        manifest: {} as never,
        rules: ["Funds may only go to its own wallet."],
        guidance: "Quote before you swap.",
        call: {
          tools: createToolset([...TOOLS]),
          signer: createPolicySigner({
            signer: agentSigner,
            policy: toolCtx.policy,
            prices: toolCtx.prices,
          }),
          ctx: toolCtx,
          log: new ActivityLog("mcp-agent", [(event) => void events.push({ ...event, ...via })]),
          approvals,
          send: send as never,
        },
      };
    },
  };
  app = createApp(ctx);
  const created = await createAgentToken(ctx, agent, { label: "test" });
  secret = created.token;
  tokenId = created.record.id;
}

const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = secret, ...rest } = init;
  return app.request(path, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
};
const tool = (name: string, input: unknown, init: RequestInit & { token?: string | null } = {}) =>
  call(`/agent/v1/tools/${name}`, { method: "POST", body: JSON.stringify({ input }), ...init });
const attack = () => tool("propose-tx", { token: "USDC", to: ATTACKER, amount: 2 });

beforeEach(() => setup());
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("tokens at the door", () => {
  it("refuses a missing, malformed or unknown token, and never echoes it", async () => {
    for (const token of [null, "nope", "syn_notarealtoken"]) {
      const res = await call("/agent/v1/me", { token });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(JSON.stringify(await res.json())).not.toContain("syn_notarealtoken");
    }
  });

  it("shows the agent and its rules to the holder, without the secret", async () => {
    const res = await call("/agent/v1/me");
    expect(res.status).toBe(200);
    const me = (await res.json()) as Record<string, unknown>;
    expect(me).toMatchObject({
      name: "mcp-agent",
      cluster: "devnet",
      runtime: "external",
      tools: [...TOOLS],
      token: { prefix: secret.slice(0, 8) },
    });
    expect(JSON.stringify(me)).not.toContain(secret);
    expect(String(JSON.stringify(me.ruleCard))).toMatch(/5 USDC per week/);
  });

  it("stores only a hash, and stops working the moment it is revoked", async () => {
    const stored = await ctx.store.tokens("mcp-agent");
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect((await call("/agent/v1/me")).status).toBe(200);
    expect(await ctx.store.revokeToken("mcp-agent", tokenId)).toBe(true);
    const after = await call("/agent/v1/me");
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthorized (revoked)" });
  });

  it("refuses an expired token", async () => {
    const old = await createAgentToken(
      ctx,
      agent,
      { days: 1 },
      new Date(Date.now() - 2 * 86_400_000),
    );
    const res = await call("/agent/v1/me", { token: old.token });
    expect(await res.json()).toEqual({ error: "unauthorized (expired)" });
  });

  it("refuses a token whose agent no longer holds its key here", async () => {
    await ctx.store.upsertAgent({ ...agent, custody: "local" });
    expect(await (await call("/agent/v1/me")).json()).toEqual({ error: "unauthorized (agent)" });
  });

  it("only offers lifetimes from the fixed list", async () => {
    await expect(createAgentToken(ctx, agent, { days: 365 })).rejects.toThrow(/lifetime/);
    await expect(createAgentToken(ctx, agent, { days: 90 })).resolves.toBeDefined();
  });

  it("keeps at most three live tokens per agent", async () => {
    await createAgentToken(ctx, agent, {});
    await createAgentToken(ctx, agent, {});
    await expect(createAgentToken(ctx, agent, {})).rejects.toThrow(/at most 3/);
    await ctx.store.revokeToken("mcp-agent", tokenId);
    await expect(createAgentToken(ctx, agent, {})).resolves.toBeDefined();
  });
});

describe("the HTTP tool door", () => {
  it("lists the manifest's tools with their schemas", async () => {
    const { tools } = (await (await call("/agent/v1/tools")).json()) as {
      tools: { name: string; inputSchema: unknown }[];
    };
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    expect(tools.every((t) => t.inputSchema)).toBe(true);
  });

  it("blocks a transfer to an unknown address with HTTP 200: nothing is signed or sent", async () => {
    const res = await attack();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tool: string; result: { status: string } };
    expect(body).toMatchObject({ tool: "propose-tx", result: { status: "blocked" } });
    expect(send).not.toHaveBeenCalled();
    const blocked = events.find((e) => e.type === "blocked");
    expect(blocked).toMatchObject({ via: "http", token: secret.slice(0, 8) });
  });

  it("refuses a paused agent's write calls, and still lets its AI read", async () => {
    await ctx.store.setAgentPaused("mcp-agent", true);
    const res = await tool("request-topup", { amount: 3, reason: "allowance used up" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tool: "request-topup",
      result: { status: "paused", error: expect.stringMatching(/owner has paused this agent/) },
    });
    expect((await attack()).status).toBe(200);
    // Nothing reached a tool, the policy or a signer.
    expect(events).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(((await (await call("/agent/v1/me")).json()) as { paused?: boolean }).paused).toBe(true);
    expect((await tool("balances", {})).status).toBe(200);
    expect(events.some((e) => e.type === "tool_call" && e.name === "balances")).toBe(true);

    await ctx.store.setAgentPaused("mcp-agent", false);
    expect(await (await tool("request-topup", { amount: 3, reason: "used up" })).text()).toContain(
      "requested",
    );
  });

  it("turns a top-up request into an owner request, not a transaction", async () => {
    const res = await tool("request-topup", { amount: 3, reason: "allowance used up" });
    expect(await res.text()).toContain("requested");
    expect(send).not.toHaveBeenCalled();
  });

  it("answers protocol mistakes with HTTP errors", async () => {
    expect((await tool("no-such-tool", {})).status).toBe(404);
    expect(
      (await call("/agent/v1/tools/propose-tx", { method: "POST", body: "{nope" })).status,
    ).toBe(400);
    expect((await call("/agent/v1/tools/propose-tx", { method: "POST", body: "[]" })).status).toBe(
      400,
    );
    expect((await tool("propose-tx", [1, 2])).status).toBe(400);
    // Input the tool rejects is a tool result, like over MCP.
    const bad = await tool("propose-tx", { amount: "lots" });
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("invalid input");
  });

  it("refuses an oversized body", async () => {
    const res = await call("/agent/v1/tools/propose-tx", {
      method: "POST",
      body: JSON.stringify({ input: { pad: "x".repeat(70_000) } }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects browser pages from other origins, and allows the dashboard's", async () => {
    const evil = await call("/agent/v1/me", { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    const dashboard = await call("/agent/v1/me", { headers: { origin: "http://localhost:3000" } });
    expect(dashboard.status).toBe(200);
  });
});

describe("limits", () => {
  it("limits calls per token, with Retry-After", async () => {
    await setup({ limits: { callsPerMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await call("/agent/v1/me")).status).toBe(200);
    const limited = await call("/agent/v1/me");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits write calls separately from reads", async () => {
    await setup({ limits: { writesPerMinute: 1 } });
    expect((await attack()).status).toBe(200);
    expect((await attack()).status).toBe(429);
    expect((await call("/agent/v1/me")).status).toBe(200); // reads are unaffected
  });

  it("limits an owner across all their tokens", async () => {
    await setup({ limits: { ownerCallsPerMinute: 2 } });
    const second = await createAgentToken(ctx, agent, {});
    expect((await call("/agent/v1/me")).status).toBe(200);
    expect((await call("/agent/v1/me", { token: second.token })).status).toBe(200);
    expect((await call("/agent/v1/me")).status).toBe(429);
  });

  it("throttles an address that keeps presenting bad tokens, even before it tries a good one", async () => {
    await setup({ limits: { failuresPerMinute: 2 } });
    const guess = () =>
      call("/agent/v1/me", { token: "syn_wrong", headers: { "x-forwarded-for": "9.9.9.9" } });
    expect((await guess()).status).toBe(401);
    expect((await guess()).status).toBe(401);
    expect((await guess()).status).toBe(429);
    const good = await call("/agent/v1/me", { headers: { "x-forwarded-for": "9.9.9.9" } });
    expect(good.status).toBe(429);
    const elsewhere = await call("/agent/v1/me", { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(elsewhere.status).toBe(200);
  });

  it("times out a slow tool call and says it may still finish", async () => {
    await setup({ limits: { toolTimeoutMs: 20 } });
    const remote = ctx.hosted?.remote;
    ctx.hosted = {
      ...(ctx.hosted as NonNullable<typeof ctx.hosted>),
      remote: async (name, via) => {
        const r = await remote?.(name, via);
        if (!r) return r;
        const slow = { ...r.call.tools, call: () => new Promise<never>(() => undefined) };
        return { ...r, call: { ...r.call, tools: slow } };
      },
    };
    const res = await tool("balances", {});
    expect(await res.text()).toMatch(/did not finish within/);
  });
});

describe("https", () => {
  it("requires TLS when the server's public URL is https", async () => {
    await setup({ publicUrl: "https://syndromi.example" });
    expect((await call("/agent/v1/me")).status).toBe(403);
    const ok = await call("/agent/v1/me", { headers: { "x-forwarded-proto": "https" } });
    expect(ok.status).toBe(200);
  });
});

describe("remote MCP", () => {
  async function connect(token = secret) {
    const server = await listen(ctx, 0);
    closers.push(server.close);
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/agent/mcp`),
      {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);
    return client;
  }
  const textOf = (result: unknown) =>
    ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

  it("serves the rules, the tools, and the policy over Streamable HTTP", async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain("Funds may only go to its own wallet.");
    expect(client.getInstructions()).toContain("Quote before you swap.");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());

    const blocked = await client.callTool({
      name: "propose-tx",
      arguments: { token: "USDC", to: ATTACKER, amount: 2 },
    });
    expect(textOf(blocked)).toContain('"status":"blocked"');
    expect(blocked.isError).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "blocked")).toMatchObject({ via: "mcp-http" });
    await client.close();
  });

  it("refuses to connect without a good token, and stops once the token is revoked", async () => {
    await expect(connect("syn_wrong")).rejects.toThrow();
    const client = await connect();
    expect((await client.listTools()).tools.length).toBe(TOOLS.length);
    await ctx.store.revokeToken("mcp-agent", tokenId);
    await expect(client.listTools()).rejects.toThrow();
    await client.close().catch(() => undefined);
  });

  it("refuses a paused agent's write calls over MCP too", async () => {
    await ctx.store.setAgentPaused("mcp-agent", true);
    const client = await connect();
    const refused = await client.callTool({
      name: "request-topup",
      arguments: { amount: 3, reason: "allowance used up" },
    });
    expect(textOf(refused)).toMatch(/owner has paused this agent/);
    expect(send).not.toHaveBeenCalled();
    await client.close();
  });

  it("applies the write limit to MCP calls too", async () => {
    await setup({ limits: { writesPerMinute: 1 } });
    const client = await connect();
    const args = { name: "propose-tx", arguments: { token: "USDC", to: ATTACKER, amount: 2 } };
    expect(textOf(await client.callTool(args))).toContain("blocked");
    const second = await client.callTool(args);
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("rate limit");
    await client.close();
  });
});

describe("the kill switch", () => {
  it("revokes every access token of the owner's agents on that cluster", async () => {
    const other = await createAgentToken(ctx, agent, {});
    const completion = ctx.completions.get("kill");
    const offline = new Proxy(
      {},
      { get: () => () => ({ send: async () => Promise.reject(new Error("offline")) }) },
    );
    ctx.rpc = () => offline as never;
    await completion?.(
      { owner: agent.owner, cluster: "devnet", ref: "0", kind: "kill" } as never,
      "sig",
    );
    for (const token of [secret, other.token]) {
      expect(await (await call("/agent/v1/me", { token })).json()).toEqual({
        error: "unauthorized (revoked)",
      });
    }
  });
});
