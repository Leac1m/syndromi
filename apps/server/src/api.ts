// The runtime's API (bearer token): register agents, submit drafts, top-up requests and
// activity, poll for approvals, and report what happened. The logic lives in records.ts, shared
// with the in-process hosted runtime.
import { type Address, isAddress } from "@solana/kit";
import type { Context, Hono } from "hono";
import type { ServerContext } from "./context.js";
import type { AgentRecord } from "./db.js";
import { createHostedAgent } from "./owner.js";
import {
  approvalsFor,
  createDraft,
  createTopUp,
  type DraftInput,
  RecordError,
  recordActivity,
  reject,
  reportDraft,
  reportTopUp,
} from "./records.js";

export function mountApi(app: Hono, ctx: ServerContext) {
  const { store, config } = ctx;

  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${config.token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  /** Runs `fn`, mapping RecordErrors to their HTTP status. */
  const handle = async (c: Context, fn: () => unknown) => {
    try {
      return c.json(serialize(await fn()));
    } catch (e) {
      if (e instanceof RecordError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };

  app.post("/api/agents", async (c) => {
    const body = (await c.req.json()) as Omit<AgentRecord, "registeredAt">;
    try {
      await store.upsertAgent({ ...body, registeredAt: new Date().toISOString() });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
    return c.json({ ok: true });
  });

  // `syndromi deploy`: create a hosted agent from a full manifest and prompt.
  app.post("/api/deploy", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      manifest?: unknown;
      prompt?: string;
      owner?: string;
      cluster?: string;
    };
    if (!body.owner || !isAddress(body.owner)) {
      return c.json({ error: "owner must be a Solana address" }, 400);
    }
    const cluster =
      (["devnet", "mainnet", "fork"] as const).find((k) => k === body.cluster) ?? "devnet";
    const result = await createHostedAgent(ctx, {
      manifest: body.manifest,
      prompt: body.prompt ?? "",
      owner: body.owner,
      cluster,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(serialize({ name: result.agent.name, address: result.agent.address, cluster }));
  });

  app.post("/api/drafts", async (c) => {
    const body = (await c.req.json()) as DraftInput;
    return handle(c, () => createDraft(ctx, body));
  });

  app.post("/api/topups", async (c) => {
    const body = (await c.req.json()) as {
      agentName: string;
      mint: Address;
      amount: string;
      reason: string;
    };
    return handle(c, () => createTopUp(ctx, body));
  });

  app.post("/api/activity", async (c) => {
    const { agentName, events } = (await c.req.json()) as {
      agentName: string;
      events: ({ type: string; at: string } & Record<string, unknown>)[];
    };
    await recordActivity(ctx, agentName, events);
    return c.json({ ok: true });
  });

  app.get("/api/agents/:name/approvals", async (c) =>
    c.json(serialize(await approvalsFor(ctx, c.req.param("name")))),
  );

  app.post("/api/drafts/:id/reject", (c) =>
    handle(c, () => reject(ctx, "draft", c.req.param("id"))),
  );
  app.post("/api/topups/:id/reject", (c) =>
    handle(c, () => reject(ctx, "topup", c.req.param("id"))),
  );

  app.post("/api/drafts/:id/result", async (c) => {
    const body = (await c.req.json()) as Parameters<typeof reportDraft>[2];
    return handle(c, () => reportDraft(ctx, c.req.param("id"), body));
  });

  app.post("/api/topups/:id/result", async (c) => {
    const body = (await c.req.json()) as Parameters<typeof reportTopUp>[2];
    return handle(c, () => reportTopUp(ctx, c.req.param("id"), body));
  });
}

/** JSON-safe copy (bigints as strings). */
export function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
