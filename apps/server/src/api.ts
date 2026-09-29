// The runtime's API (bearer token): register agents, submit drafts, top-up requests and
// activity, poll for approvals, and report what happened.
import type { Address } from "@solana/kit";
import type { Cluster, Decision, Intent } from "@syndromi/core";
import type { Hono } from "hono";
import { newId, type ServerContext } from "./context.js";
import type { AgentRecord, DraftRecord, TopUpRecord } from "./db.js";

type DraftInput = {
  agentName: string;
  agent: Address;
  tool: string;
  input: unknown;
  intent: Intent & { inputAmount?: string | bigint };
  decision: Decision;
  summary: string;
  simulationError?: string;
};

export function mountApi(app: Hono, ctx: ServerContext) {
  const { store, bus, config } = ctx;

  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${config.token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/api/agents", async (c) => {
    const body = (await c.req.json()) as Omit<AgentRecord, "registeredAt">;
    store.upsertAgent({ ...body, registeredAt: new Date().toISOString() });
    return c.json({ ok: true });
  });

  app.post("/api/drafts", async (c) => {
    const body = (await c.req.json()) as DraftInput;
    const agent = store.agent(body.agentName);
    if (!agent) return c.json({ error: `unknown agent ${body.agentName}` }, 404);
    const now = Date.now();
    const draft: DraftRecord = {
      id: newId("d"),
      agentName: agent.name,
      agent: agent.address,
      owner: agent.owner,
      cluster: agent.cluster,
      tool: body.tool,
      input: body.input,
      intent: {
        ...body.intent,
        ...(body.intent.inputAmount !== undefined
          ? { inputAmount: BigInt(body.intent.inputAmount) }
          : {}),
      },
      decision: body.decision,
      summary: body.summary,
      usd: body.decision.usd ?? 0,
      ...(body.simulationError ? { simulationError: body.simulationError } : {}),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.draftTtlMs).toISOString(),
    };
    store.saveDraft(draft);
    bus.emit("draft", draft);
    return c.json(serialize(draft));
  });

  app.post("/api/topups", async (c) => {
    const body = (await c.req.json()) as {
      agentName: string;
      mint: Address;
      amount: string;
      reason: string;
    };
    const agent = store.agent(body.agentName);
    if (!agent) return c.json({ error: `unknown agent ${body.agentName}` }, 404);
    const now = Date.now();
    const topup: TopUpRecord = {
      id: newId("t"),
      agentName: agent.name,
      agent: agent.address,
      owner: agent.owner,
      cluster: agent.cluster as Cluster,
      mint: body.mint,
      amount: BigInt(body.amount),
      reason: body.reason,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.topUpTtlMs).toISOString(),
    };
    store.saveTopUp(topup);
    bus.emit("topup", topup);
    return c.json(serialize(topup));
  });

  app.post("/api/activity", async (c) => {
    const { agentName, events } = (await c.req.json()) as {
      agentName: string;
      events: ({ type: string; at: string } & Record<string, unknown>)[];
    };
    for (const event of events) {
      store.addActivity(agentName, event);
      bus.emit("activity", agentName, event);
    }
    return c.json({ ok: true });
  });

  app.get("/api/agents/:name/approvals", (c) => {
    const agentName = c.req.param("name");
    return c.json({
      drafts: store.drafts({ agentName, status: "approved" }).map(serialize),
      topups: store.topUps({ agentName, status: "approved" }).map(serialize),
    });
  });

  app.post("/api/drafts/:id/result", async (c) => {
    const body = (await c.req.json()) as {
      status: "executed" | "failed" | "stale";
      signature?: string;
      error?: string;
    };
    const draft = store.draft(c.req.param("id"));
    if (!draft) return c.json({ error: "no such draft" }, 404);
    if (draft.status !== "approved") return c.json({ error: `draft is ${draft.status}` }, 409);
    const updated = store.updateDraft(draft.id, {
      status: body.status,
      ...(body.signature ? { resultSignature: body.signature } : {}),
      ...(body.error ? { resultError: body.error } : {}),
    });
    bus.emit("draft", updated);
    return c.json(serialize(updated));
  });

  app.post("/api/topups/:id/result", async (c) => {
    const body = (await c.req.json()) as {
      status: "pulled" | "failed";
      signature?: string;
      error?: string;
    };
    const topup = store.topUp(c.req.param("id"));
    if (!topup) return c.json({ error: "no such top-up" }, 404);
    if (topup.status !== "approved") return c.json({ error: `top-up is ${topup.status}` }, 409);
    const updated = store.updateTopUp(topup.id, {
      status: body.status,
      ...(body.signature ? { resultSignature: body.signature } : {}),
      ...(body.error ? { resultError: body.error } : {}),
    });
    bus.emit("topup", updated);
    return c.json(serialize(updated));
  });
}

/** JSON-safe copy (bigints as strings). */
export function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
