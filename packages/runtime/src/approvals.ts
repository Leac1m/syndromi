// Where held proposals and top-up requests go. Day 3 writes JSON files next to the agent's
// keypair; Day 4's server implements the same interface and pushes them to Telegram as Blinks.
//
// A draft stores what the tool was asked to do, not a signed transaction: blockhashes expire in
// about a minute. On approval the runtime re-runs the tool, re-evaluates the policy, and signs
// with `approvedDraftId` only if the verdict is not `block`.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import type { Decision, Intent } from "@syndromi/core";
import { toJson } from "./json.js";

export type Draft = {
  id: string;
  agent: Address;
  tool: string;
  input: unknown;
  intent: Intent;
  decision: Decision;
  summary: string;
  simulationError?: string;
  createdAt: string;
  status: "pending";
};

export type TopUpRequest = {
  id: string;
  agent: Address;
  mint: Address;
  amount: bigint;
  reason: string;
  createdAt: string;
  status: "pending";
};

type New<T> = Omit<T, "id" | "createdAt" | "status">;

export interface ApprovalGateway {
  submitDraft(draft: New<Draft>): Promise<Draft>;
  requestTopUp(request: New<TopUpRequest>): Promise<TopUpRequest>;
}

export class LocalApprovalGateway implements ApprovalGateway {
  constructor(private readonly dir: string) {}

  async submitDraft(draft: New<Draft>): Promise<Draft> {
    return this.write("drafts", { ...draft, ...stamp() });
  }

  async requestTopUp(request: New<TopUpRequest>): Promise<TopUpRequest> {
    return this.write("topups", { ...request, ...stamp() });
  }

  private async write<T extends { id: string }>(kind: string, record: T): Promise<T> {
    const dir = join(this.dir, kind);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${record.id}.json`), `${toJson(record, 2)}\n`, { flag: "wx" });
    return record;
  }
}

const stamp = () => ({
  id: crypto.randomUUID().slice(0, 8),
  createdAt: new Date().toISOString(),
  status: "pending" as const,
});
