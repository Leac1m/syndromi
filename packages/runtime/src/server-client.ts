// Talking to the approvals server: register the agent, hand it drafts, top-up requests and
// activity, and poll for what the owner approved.
import type { Address } from "@solana/kit";
import type { Cluster, Decision, Intent } from "@syndromi/core";
import type { ActivityEvent, ActivitySink } from "./activity.js";
import type { ApprovalGateway, Draft, TopUpRequest } from "./approvals.js";
import { toJson } from "./json.js";

type Fetch = typeof fetch;

export type ApprovedDraft = {
  id: string;
  agent: Address;
  owner: Address;
  tool: string;
  input: unknown;
  intent: Intent;
  decision: Decision;
  summary: string;
  usd: number;
  approvalText: string;
  approvalSignature: string;
};

export type ApprovedTopUp = {
  id: string;
  agent: Address;
  owner: Address;
  mint: Address;
  amount: bigint;
  delegation: Address;
};

export type AgentRegistration = {
  name: string;
  address: Address;
  owner: Address;
  cluster: Cluster;
  allowanceMint: Address;
  rules: { maxTxUsd: number; approveAboveUsd: number; destinations: string[]; programs: string[] };
  runtime?: "local" | "hosted";
  allowance?: { mint: string; amount: number; period: "daily" | "weekly" | "monthly" };
  feeBudgetSol?: number;
};

export class ServerClient {
  private readonly base: string;
  constructor(private readonly opts: { url: string; token: string; fetch?: Fetch }) {
    this.base = opts.url.replace(/\/+$/, "");
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: toJson(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      throw new Error(`server ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }

  register(agent: AgentRegistration) {
    return this.call<{ ok: true }>("/api/agents", agent);
  }

  submitDraft(agentName: string, draft: Omit<Draft, "id" | "createdAt" | "status">) {
    return this.call<{ id: string; createdAt: string }>("/api/drafts", { agentName, ...draft });
  }

  requestTopUp(agentName: string, request: { mint: Address; amount: bigint; reason: string }) {
    return this.call<{ id: string; createdAt: string }>("/api/topups", { agentName, ...request });
  }

  postActivity(agentName: string, events: ActivityEvent[]) {
    return this.call<{ ok: true }>("/api/activity", { agentName, events });
  }

  async approvals(
    agentName: string,
  ): Promise<{ drafts: ApprovedDraft[]; topups: ApprovedTopUp[] }> {
    const raw = await this.call<{
      drafts: (ApprovedDraft & { intent: Intent & { inputAmount?: string } })[];
      topups: (ApprovedTopUp & { amount: string })[];
    }>(`/api/agents/${encodeURIComponent(agentName)}/approvals`);
    return {
      drafts: raw.drafts.map((d) => ({
        ...d,
        intent: {
          ...d.intent,
          ...(d.intent.inputAmount !== undefined
            ? { inputAmount: BigInt(d.intent.inputAmount) }
            : {}),
        },
      })),
      topups: raw.topups.map((t) => ({ ...t, amount: BigInt(t.amount) })),
    };
  }

  reject(kind: "draft" | "topup", id: string) {
    return this.call(`/api/${kind === "draft" ? "drafts" : "topups"}/${id}/reject`, {});
  }

  reportDraft(
    id: string,
    result: { status: "executed" | "failed" | "stale"; signature?: string; error?: string },
  ) {
    return this.call(`/api/drafts/${id}/result`, result);
  }

  reportTopUp(
    id: string,
    result: { status: "pulled" | "failed"; signature?: string; error?: string },
  ) {
    return this.call(`/api/topups/${id}/result`, result);
  }
}

/** Drafts and top-up requests go to the server (which pushes them to Telegram). */
export class HttpApprovalGateway implements ApprovalGateway {
  constructor(
    private readonly client: ServerClient,
    private readonly agentName: string,
  ) {}

  async submitDraft(draft: Omit<Draft, "id" | "createdAt" | "status">): Promise<Draft> {
    const saved = await this.client.submitDraft(this.agentName, draft);
    return { ...draft, id: saved.id, createdAt: saved.createdAt, status: "pending" };
  }

  async requestTopUp(
    request: Omit<TopUpRequest, "id" | "createdAt" | "status">,
  ): Promise<TopUpRequest> {
    const saved = await this.client.requestTopUp(this.agentName, request);
    return { ...request, id: saved.id, createdAt: saved.createdAt, status: "pending" };
  }
}

/** Forwards activity to the server (feed + BLOCKED alerts). Failures never stop a run. */
export function httpSink(client: ServerClient, agentName: string): ActivitySink {
  return async (event) => {
    await client.postActivity(agentName, [event]).catch((e) => {
      console.error(`activity upload failed: ${(e as Error).message}`);
    });
  };
}
