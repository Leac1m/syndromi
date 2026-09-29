// Drafts, top-up requests, approvals and activity as plain functions over the store, shared by
// the HTTP API (/api/*, for local runtimes) and the in-process hosted runtime.
import type { Address } from "@solana/kit";
import type { Decision, Intent } from "@syndromi/core";
import { newId, type ServerContext } from "./context.js";
import type { DraftRecord, TopUpRecord } from "./db.js";

export type DraftInput = {
  agentName: string;
  tool: string;
  input: unknown;
  intent: Intent & { inputAmount?: string | bigint };
  decision: Decision;
  summary: string;
  simulationError?: string;
};

export class RecordError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

export function createDraft(ctx: ServerContext, body: DraftInput): DraftRecord {
  const agent = ctx.store.agent(body.agentName);
  if (!agent) throw new RecordError(`unknown agent ${body.agentName}`, 404);
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
    } as Intent,
    decision: body.decision,
    summary: body.summary,
    usd: body.decision.usd ?? 0,
    ...(body.simulationError ? { simulationError: body.simulationError } : {}),
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ctx.config.draftTtlMs).toISOString(),
  };
  ctx.store.saveDraft(draft);
  ctx.bus.emit("draft", draft);
  return draft;
}

export function createTopUp(
  ctx: ServerContext,
  body: { agentName: string; mint: Address; amount: bigint | string; reason: string },
): TopUpRecord {
  const agent = ctx.store.agent(body.agentName);
  if (!agent) throw new RecordError(`unknown agent ${body.agentName}`, 404);
  const now = Date.now();
  const topup: TopUpRecord = {
    id: newId("t"),
    agentName: agent.name,
    agent: agent.address,
    owner: agent.owner,
    cluster: agent.cluster,
    mint: body.mint,
    amount: BigInt(body.amount),
    reason: body.reason,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ctx.config.topUpTtlMs).toISOString(),
  };
  ctx.store.saveTopUp(topup);
  ctx.bus.emit("topup", topup);
  return topup;
}

export function recordActivity(
  ctx: ServerContext,
  agentName: string,
  events: ({ type: string; at: string } & Record<string, unknown>)[],
) {
  for (const event of events) {
    ctx.store.addActivity(agentName, event);
    ctx.bus.emit("activity", agentName, event);
  }
}

/** What the owner approved for an agent, in the shape the runtime's watcher consumes. */
export function approvalsFor(ctx: ServerContext, agentName: string) {
  return {
    drafts: ctx.store.drafts({ agentName, status: "approved" }).map((d) => ({
      id: d.id,
      agent: d.agent,
      owner: d.owner,
      tool: d.tool,
      input: d.input,
      intent: d.intent,
      decision: d.decision,
      summary: d.summary,
      usd: d.usd,
      approvalText: d.approvalText ?? "",
      approvalSignature: d.approvalSignature ?? "",
    })),
    topups: ctx.store
      .topUps({ agentName, status: "approved" })
      .filter((t): t is TopUpRecord & { delegation: Address } => Boolean(t.delegation))
      .map((t) => ({
        id: t.id,
        agent: t.agent,
        owner: t.owner,
        mint: t.mint,
        amount: t.amount,
        delegation: t.delegation,
      })),
  };
}

export function reportDraft(
  ctx: ServerContext,
  id: string,
  result: { status: "executed" | "failed" | "stale"; signature?: string; error?: string },
) {
  const draft = ctx.store.draft(id);
  if (!draft) throw new RecordError("no such draft", 404);
  if (draft.status !== "approved") throw new RecordError(`draft is ${draft.status}`, 409);
  const updated = ctx.store.updateDraft(draft.id, {
    status: result.status,
    ...(result.signature ? { resultSignature: result.signature } : {}),
    ...(result.error ? { resultError: result.error } : {}),
  });
  ctx.bus.emit("draft", updated);
  return updated;
}

export function reportTopUp(
  ctx: ServerContext,
  id: string,
  result: { status: "pulled" | "failed"; signature?: string; error?: string },
) {
  const topup = ctx.store.topUp(id);
  if (!topup) throw new RecordError("no such top-up", 404);
  if (topup.status !== "approved") throw new RecordError(`top-up is ${topup.status}`, 409);
  const updated = ctx.store.updateTopUp(topup.id, {
    status: result.status,
    ...(result.signature ? { resultSignature: result.signature } : {}),
    ...(result.error ? { resultError: result.error } : {}),
  });
  ctx.bus.emit("topup", updated);
  return updated;
}

export function reject(ctx: ServerContext, kind: "draft" | "topup", id: string) {
  const record = kind === "draft" ? ctx.store.draft(id) : ctx.store.topUp(id);
  if (!record) throw new RecordError(`no such ${kind}`, 404);
  if (record.status !== "pending") throw new RecordError(`${kind} is ${record.status}`, 409);
  if (kind === "draft") {
    const updated = ctx.store.updateDraft(id, { status: "rejected" });
    ctx.bus.emit("draft", updated);
    return updated;
  }
  const updated = ctx.store.updateTopUp(id, { status: "rejected" });
  ctx.bus.emit("topup", updated);
  return updated;
}
