// SQLite store (Node's built-in node:sqlite): agents, drafts, top-up requests, activity, and the
// nonces handed out for owner signatures.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address } from "@solana/kit";
import type { Cluster, Decision, Intent } from "@syndromi/core";

export type AgentRecord = {
  name: string;
  address: Address;
  owner: Address;
  cluster: Cluster;
  allowanceMint: Address;
  rules: { maxTxUsd: number; approveAboveUsd: number; destinations: string[]; programs: string[] };
  registeredAt: string;
};

export type DraftStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "failed"
  | "stale";

export type DraftRecord = {
  id: string;
  agentName: string;
  agent: Address;
  owner: Address;
  cluster: Cluster;
  tool: string;
  input: unknown;
  intent: Intent;
  decision: Decision;
  summary: string;
  usd: number;
  simulationError?: string;
  status: DraftStatus;
  createdAt: string;
  expiresAt: string;
  approvalText?: string;
  approvalSignature?: string;
  resultSignature?: string;
  resultError?: string;
};

export type TopUpStatus = "pending" | "approved" | "rejected" | "expired" | "pulled" | "failed";

export type TopUpRecord = {
  id: string;
  agentName: string;
  agent: Address;
  owner: Address;
  cluster: Cluster;
  mint: Address;
  amount: bigint;
  reason: string;
  status: TopUpStatus;
  createdAt: string;
  expiresAt: string;
  /** The fixed-delegation PDA the owner's approval transaction creates (set when built). */
  delegation?: Address;
  /** Base64 message bytes of the transaction issued for signing; only this may be submitted. */
  issuedMessage?: string;
  approvalSignature?: string;
  resultSignature?: string;
  resultError?: string;
};

const SCHEMA = `
create table if not exists agents (
  name text primary key, address text not null, owner text not null, cluster text not null,
  allowance_mint text not null, rules text not null, registered_at text not null);
create table if not exists drafts (
  id text primary key, agent_name text not null, status text not null, created_at text not null,
  expires_at text not null, data text not null);
create table if not exists topups (
  id text primary key, agent_name text not null, status text not null, created_at text not null,
  expires_at text not null, data text not null);
create table if not exists activity (
  seq integer primary key autoincrement, agent_name text not null, type text not null,
  at text not null, data text not null);
create table if not exists sign_requests (
  nonce text primary key, draft_id text not null, text text not null, created_at text not null,
  used integer not null default 0);
create table if not exists settings (key text primary key, value text not null);
`;

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------------ agents
  upsertAgent(agent: AgentRecord) {
    this.db
      .prepare(
        `insert into agents values (?, ?, ?, ?, ?, ?, ?)
         on conflict(name) do update set address = excluded.address, owner = excluded.owner,
           cluster = excluded.cluster, allowance_mint = excluded.allowance_mint,
           rules = excluded.rules`,
      )
      .run(
        agent.name,
        agent.address,
        agent.owner,
        agent.cluster,
        agent.allowanceMint,
        json(agent.rules),
        agent.registeredAt,
      );
  }

  agent(name: string): AgentRecord | undefined {
    const row = this.db.prepare("select * from agents where name = ?").get(name) as
      | Record<string, string>
      | undefined;
    if (!row) return undefined;
    return {
      name: row.name as string,
      address: row.address as Address,
      owner: row.owner as Address,
      cluster: row.cluster as Cluster,
      allowanceMint: row.allowance_mint as Address,
      rules: JSON.parse(row.rules as string),
      registeredAt: row.registered_at as string,
    };
  }

  agents(): AgentRecord[] {
    const rows = this.db.prepare("select name from agents order by name").all() as {
      name: string;
    }[];
    return rows.map((r) => this.agent(r.name)).filter((a): a is AgentRecord => Boolean(a));
  }

  // ------------------------------------------------------------------ drafts
  saveDraft(draft: DraftRecord) {
    this.db
      .prepare(
        `insert into drafts values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set status = excluded.status, data = excluded.data`,
      )
      .run(draft.id, draft.agentName, draft.status, draft.createdAt, draft.expiresAt, json(draft));
  }

  draft(id: string): DraftRecord | undefined {
    const row = this.db.prepare("select data from drafts where id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? reviveDraft(row.data) : undefined;
  }

  drafts(filter: { agentName?: string; status?: DraftStatus } = {}): DraftRecord[] {
    const rows = this.db
      .prepare(
        `select data from drafts where (?1 is null or agent_name = ?1)
         and (?2 is null or status = ?2) order by created_at`,
      )
      .all(filter.agentName ?? null, filter.status ?? null) as { data: string }[];
    return rows.map((r) => reviveDraft(r.data));
  }

  updateDraft(id: string, patch: Partial<DraftRecord>): DraftRecord {
    const current = this.draft(id);
    if (!current) throw new Error(`no draft ${id}`);
    const next = { ...current, ...patch };
    this.saveDraft(next);
    return next;
  }

  // ------------------------------------------------------------------ top-ups
  saveTopUp(topup: TopUpRecord) {
    this.db
      .prepare(
        `insert into topups values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set status = excluded.status, data = excluded.data`,
      )
      .run(topup.id, topup.agentName, topup.status, topup.createdAt, topup.expiresAt, json(topup));
  }

  topUp(id: string): TopUpRecord | undefined {
    const row = this.db.prepare("select data from topups where id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? reviveTopUp(row.data) : undefined;
  }

  topUps(filter: { agentName?: string; status?: TopUpStatus } = {}): TopUpRecord[] {
    const rows = this.db
      .prepare(
        `select data from topups where (?1 is null or agent_name = ?1)
         and (?2 is null or status = ?2) order by created_at`,
      )
      .all(filter.agentName ?? null, filter.status ?? null) as { data: string }[];
    return rows.map((r) => reviveTopUp(r.data));
  }

  updateTopUp(id: string, patch: Partial<TopUpRecord>): TopUpRecord {
    const current = this.topUp(id);
    if (!current) throw new Error(`no top-up ${id}`);
    const next = { ...current, ...patch };
    this.saveTopUp(next);
    return next;
  }

  // ------------------------------------------------------------------ activity
  addActivity(agentName: string, event: { type: string; at: string } & Record<string, unknown>) {
    this.db
      .prepare("insert into activity (agent_name, type, at, data) values (?, ?, ?, ?)")
      .run(agentName, event.type, event.at, json(event));
  }

  activity(opts: { agentName?: string; limit?: number } = {}) {
    const rows = this.db
      .prepare(
        `select data from activity where (?1 is null or agent_name = ?1)
         order by seq desc limit ?2`,
      )
      .all(opts.agentName ?? null, opts.limit ?? 100) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Record<string, unknown>);
  }

  // ------------------------------------------------------------------ signing nonces
  issueSignRequest(nonce: string, draftId: string, text: string) {
    this.db
      .prepare("insert into sign_requests (nonce, draft_id, text, created_at) values (?, ?, ?, ?)")
      .run(nonce, draftId, text, new Date().toISOString());
  }

  /** Returns the issued text and marks the nonce used, or undefined if unknown/used/mismatched. */
  consumeSignRequest(nonce: string, draftId: string): string | undefined {
    const row = this.db
      .prepare("select text, used, draft_id from sign_requests where nonce = ?")
      .get(nonce) as { text: string; used: number; draft_id: string } | undefined;
    if (!row || row.used || row.draft_id !== draftId) return undefined;
    this.db.prepare("update sign_requests set used = 1 where nonce = ?").run(nonce);
    return row.text;
  }

  // ------------------------------------------------------------------ settings
  setting(key: string): string | undefined {
    const row = this.db.prepare("select value from settings where key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare(
        "insert into settings values (?, ?) on conflict(key) do update set value = excluded.value",
      )
      .run(key, value);
  }
}

function reviveDraft(data: string): DraftRecord {
  const d = JSON.parse(data) as DraftRecord & { intent: Intent & { inputAmount?: string } };
  return {
    ...d,
    intent: {
      ...d.intent,
      ...(d.intent.inputAmount !== undefined ? { inputAmount: BigInt(d.intent.inputAmount) } : {}),
    },
  };
}

function reviveTopUp(data: string): TopUpRecord {
  const t = JSON.parse(data) as TopUpRecord & { amount: string };
  return { ...t, amount: BigInt(t.amount) };
}
