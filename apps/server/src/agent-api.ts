// The owner's AI reaches a server-held agent here, with a per-agent bearer token:
//   GET  /agent/v1/me                the agent, its rules, what is left of its allowance
//   GET  /agent/v1/tools             the tool list with JSON Schemas
//   POST /agent/v1/tools/:name       {"input": {…}} → the same result text an MCP client gets
//   ALL  /agent/mcp                  MCP over Streamable HTTP (stateless, JSON responses)
// Both doors call `callTool` on the agent's loaded context, so nothing new decides anything: the
// policy signer executes, holds for the owner, or blocks, and every outcome is HTTP 200 with the
// verdict in the body. HTTP errors are only for the protocol: 400 input, 401 token, 403 origin or
// plain http, 404 tool, 413 size, 429 rate, 503 not ready.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { decimalsOf, listDelegations, toUiAmount } from "@syndromi/core";
import { buildMcpServer, callTool, type ToolCallOptions } from "@syndromi/runtime";
import type { Toolset } from "@syndromi/tools";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerContext } from "./context.js";
import type { AgentRecord, TokenRecord } from "./db.js";
import { publicAgent } from "./owner.js";
import { RateLimiter } from "./rate-limit.js";
import { checkToken } from "./tokens.js";

export type AgentLimits = {
  /** Calls per token per minute (of which `writesPerMinute` may be writes). */
  callsPerMinute: number;
  writesPerMinute: number;
  /** Calls per owner per minute, across all their agents and tokens. */
  ownerCallsPerMinute: number;
  /** Bad-token attempts per client address per minute before it is refused outright. */
  failuresPerMinute: number;
  bodyBytes: number;
  toolTimeoutMs: number;
};

export const DEFAULT_LIMITS: AgentLimits = {
  callsPerMinute: 60,
  writesPerMinute: 10,
  ownerCallsPerMinute: 200,
  failuresPerMinute: 20,
  bodyBytes: 64 * 1024,
  toolTimeoutMs: 30_000,
};

type Env = { Variables: { agent: AgentRecord; token: TokenRecord } };

export function mountAgentApi(app: Hono, ctx: ServerContext) {
  const limits = { ...DEFAULT_LIMITS, ...ctx.config.agentLimits };
  const limiter = new RateLimiter();
  const requireHttps = ctx.config.publicUrl.startsWith("https://");
  const gate = new Map<string, Promise<unknown>>();

  const tooMany = (c: Context, retryAfter: number, what: string) => {
    c.header("retry-after", String(retryAfter));
    return c.json({ error: `rate limit: ${what}; retry in ${retryAfter}s` }, 429);
  };

  /** Calls to one agent run one at a time: two doors cannot race the same allowance. */
  const serial = <T>(agent: string, fn: () => Promise<T>): Promise<T> => {
    const run = (gate.get(agent) ?? Promise.resolve()).then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    gate.set(agent, settled);
    void settled.then(() => {
      if (gate.get(agent) === settled) gate.delete(agent);
    });
    return run;
  };

  const withTimeout = <T>(work: Promise<T>, onTimeout: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout), limits.toolTimeoutMs);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  };

  const timedOut = (name: string) =>
    `${name} did not finish within ${limits.toolTimeoutMs / 1000}s. It may still complete: check balances or the owner's feed before trying again.`;

  /** The agent's tools with this token's write limit, one-at-a-time execution and a deadline. */
  const guarded = (tools: Toolset, agent: AgentRecord, token: TokenRecord): Toolset => ({
    ...tools,
    call: async (name, input, toolCtx) => {
      const tool = tools.tools.find((t) => t.name === name);
      if (tool?.kind === "write") {
        const taken = limiter.take(`write:${token.id}`, limits.writesPerMinute);
        if (!taken.ok) {
          return {
            type: "error",
            error: `rate limit: at most ${limits.writesPerMinute} write calls a minute; retry in ${taken.retryAfter}s`,
          };
        }
      }
      return serial(agent.name, () =>
        withTimeout(tools.call(name, input, toolCtx), {
          type: "error" as const,
          error: timedOut(name),
        }),
      );
    },
  });

  const remoteOf = async (c: Context<Env>, via: "mcp-http" | "http") => {
    if (!ctx.hosted?.remote) {
      return { error: c.json({ error: "server-held agents are not enabled on this server" }, 503) };
    }
    const token = c.get("token");
    const remote = await ctx.hosted.remote(c.get("agent").name, { via, token: token.prefix });
    if (!remote) {
      return { error: c.json({ error: "this agent is not ready; try again shortly" }, 503) };
    }
    return { remote };
  };

  app.use("/agent/*", async (c, next) => {
    if (requireHttps) {
      const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
      const proto = forwarded ?? new URL(c.req.url).protocol.replace(":", "");
      if (proto !== "https") return c.json({ error: "https is required" }, 403);
    }
    // A browser page cannot drive this API: only the dashboard's origins (or no Origin: CLIs and
    // servers) pass. The bearer token is not a cookie, so there is nothing for a page to ride on.
    const origin = c.req.header("origin");
    if (origin && !ctx.config.dashboardOrigins.includes(origin)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    await next();
  });

  app.use(
    "/agent/*",
    bodyLimit({
      maxSize: limits.bodyBytes,
      onError: (c) => c.json({ error: `request body over ${limits.bodyBytes} bytes` }, 413),
    }),
  );

  app.use("/agent/*", async (c: Context<Env>, next) => {
    const client = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "direct";
    const failKey = `fail:${client}`;
    const blocked = limiter.peek(failKey, limits.failuresPerMinute);
    if (!blocked.ok) return tooMany(c, blocked.retryAfter, "too many bad tokens from this address");

    const presented = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
    const checked = await checkToken(ctx, presented);
    if (!checked.ok) {
      limiter.take(failKey, limits.failuresPerMinute);
      c.header("www-authenticate", 'Bearer realm="syndromi"');
      return c.json({ error: `unauthorized (${checked.reason})` }, 401);
    }

    const { token, agent } = checked;
    const perToken = limiter.take(`calls:${token.id}`, limits.callsPerMinute);
    if (!perToken.ok) return tooMany(c, perToken.retryAfter, "too many calls for this token");
    const perOwner = limiter.take(`owner:${token.owner}`, limits.ownerCallsPerMinute);
    if (!perOwner.ok) return tooMany(c, perOwner.retryAfter, "too many calls for this owner");

    if (!token.lastUsedAt || Date.now() - Date.parse(token.lastUsedAt) > 60_000) {
      await ctx.store.touchToken(token.id).catch(() => undefined);
    }
    c.set("token", token);
    c.set("agent", agent);
    await next();
  });

  app.get("/agent/v1/me", async (c: Context<Env>) => {
    const agent = c.get("agent");
    const token = c.get("token");
    let allowanceLeft: { remaining: number; limit: number; periodEndsAt?: number } | undefined;
    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const delegations = await listDelegations(ctx.rpc(agent.cluster), agent.owner, now);
      const own = delegations.find((d) => d.agent === agent.address && d.kind === "allowance");
      if (own) {
        allowanceLeft = {
          remaining: toUiAmount(own.remaining, decimalsOf(own.mint)),
          limit: toUiAmount(own.limit, decimalsOf(own.mint)),
          ...(own.periodEndsAt ? { periodEndsAt: Number(own.periodEndsAt) * 1000 } : {}),
        };
      }
    } catch {
      // The chain is unreachable: everything else is still useful.
    }
    const tools = ((agent.manifest?.tools as string[] | undefined) ?? []).slice();
    return c.json({
      ...publicAgent(agent),
      tools,
      ...(allowanceLeft ? { allowanceLeft } : {}),
      token: { prefix: token.prefix, expiresAt: token.expiresAt },
    });
  });

  app.get("/agent/v1/tools", async (c: Context<Env>) => {
    const { remote, error } = await remoteOf(c, "http");
    if (!remote) return error;
    return c.json({ tools: remote.call.tools.describe() });
  });

  app.post("/agent/v1/tools/:name", async (c: Context<Env>) => {
    const { remote, error } = await remoteOf(c, "http");
    if (!remote) return error;
    const name = c.req.param("name") ?? "";
    const tool = remote.call.tools.tools.find((t) => t.name === name);
    if (!tool) return c.json({ error: `no tool "${name}" on this agent` }, 404);

    const raw = (await c.req.json().catch(() => undefined)) as { input?: unknown } | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: 'send a JSON body: {"input": {…}}' }, 400);
    }
    const input = raw.input ?? {};
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return c.json({ error: '"input" must be an object' }, 400);
    }

    const agent = c.get("agent");
    if (tool.kind === "write") {
      const taken = limiter.take(`write:${c.get("token").id}`, limits.writesPerMinute);
      if (!taken.ok) return tooMany(c, taken.retryAfter, "too many write calls for this token");
    }
    const options: ToolCallOptions = remote.call;
    const text = await serial(agent.name, () =>
      withTimeout(
        callTool({ id: crypto.randomUUID(), name, input }, options),
        JSON.stringify({ tool: name, result: { status: "timeout", error: timedOut(name) } }),
      ),
    );
    return c.body(text, 200, { "content-type": "application/json; charset=utf-8" });
  });

  // MCP: stateless, so there is no session to lose on a restart. A fresh server and transport per
  // request, answering with plain JSON.
  app.all("/agent/mcp", async (c: Context<Env>) => {
    const { remote, error } = await remoteOf(c, "mcp-http");
    if (!remote) return error;
    const server = buildMcpServer({
      name: c.get("agent").name,
      rules: remote.rules,
      guidance: remote.guidance,
      call: { ...remote.call, tools: guarded(remote.call.tools, c.get("agent"), c.get("token")) },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  });
}
