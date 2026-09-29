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
  runtime?: "local" | "hosted";
  /** As in the manifest: token symbol (or mint), amount per period, period. */
  allowance?: { mint: string; amount: number; period: "daily" | "weekly" | "monthly" };
  feeBudgetSol?: number;
  /** Hosted agents: the full manifest and prompt the server runs (Day 6). */
  manifest?: Record<string, unknown>;
  prompt?: string;
};

/** An activity event as stored: the runtime's fields plus its sequence number and agent. */
export type ActivityRow = { seq: number; agentName: string; type?: string } & Record<
  string,
  unknown
>;

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
  approvalSignature?: string;
  resultSignature?: string;
  resultError?: string;
};

const SCHEMA = `
create table if not exists agent_records (
  name text primary key, owner text not null, data text not null);
create table if not exists hosted_keys (name text primary key, data text not null);
create table if not exists sessions (
  token text primary key, owner text not null, expires_at text not null);
create table if not exists login_nonces (
  nonce text primary key, owner text not null, text text not null, created_at text not null,
  used integer not null default 0);
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
create table if not exists owner_txs (id text primary key, data text not null);
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
    const previous = this.agent(agent.name);
    // Registration from a runtime must not erase what the server already knows (e.g. a hosted
    // agent's manifest), and never moves an agent to a different owner.
    if (previous && previous.owner !== agent.owner) {
      throw new Error(`agent ${agent.name} belongs to a different owner`);
    }
    const merged = {
      ...previous,
      ...agent,
      registeredAt: previous?.registeredAt ?? agent.registeredAt,
    };
    this.db
      .prepare(
        `insert into agent_records values (?, ?, ?)
         on conflict(name) do update set owner = excluded.owner, data = excluded.data`,
      )
      .run(agent.name, agent.owner, json(merged));
  }

  agent(name: string): AgentRecord | undefined {
    const row = this.db.prepare("select data from agent_records where name = ?").get(name) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as AgentRecord) : undefined;
  }

  agents(owner?: string): AgentRecord[] {
    const rows = this.db
      .prepare("select data from agent_records where (?1 is null or owner = ?1) order by name")
      .all(owner ?? null) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as AgentRecord);
  }

  saveHostedKey(name: string, encrypted: unknown) {
    this.db
      .prepare(
        "insert into hosted_keys values (?, ?) on conflict(name) do update set data = excluded.data",
      )
      .run(name, JSON.stringify(encrypted));
  }

  hostedKey(name: string): unknown {
    const row = this.db.prepare("select data from hosted_keys where name = ?").get(name) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  // ------------------------------------------------------------------ owner sessions
  issueLoginNonce(nonce: string, owner: string, text: string) {
    this.db
      .prepare("insert into login_nonces (nonce, owner, text, created_at) values (?, ?, ?, ?)")
      .run(nonce, owner, text, new Date().toISOString());
  }

  consumeLoginNonce(nonce: string, owner: string): string | undefined {
    const row = this.db
      .prepare("select text, owner, used from login_nonces where nonce = ?")
      .get(nonce) as { text: string; owner: string; used: number } | undefined;
    if (!row || row.used || row.owner !== owner) return undefined;
    this.db.prepare("update login_nonces set used = 1 where nonce = ?").run(nonce);
    return row.text;
  }

  createSession(token: string, owner: string, expiresAt: string) {
    this.db.prepare("insert into sessions values (?, ?, ?)").run(token, owner, expiresAt);
  }

  sessionOwner(token: string, now = new Date()): string | undefined {
    const row = this.db
      .prepare("select owner, expires_at from sessions where token = ?")
      .get(token) as { owner: string; expires_at: string } | undefined;
    if (!row || Date.parse(row.expires_at) < now.getTime()) return undefined;
    return row.owner;
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

  /** Newest first, or (with `after`) everything newer than a sequence number, oldest first. */
  activity(opts: { agentNames?: string[]; after?: number; limit?: number } = {}) {
    const names = opts.agentNames;
    if (names && names.length === 0) return [];
    const placeholders = names ? names.map(() => "?").join(", ") : "";
    const where = [
      names ? `agent_name in (${placeholders})` : "1 = 1",
      opts.after !== undefined ? "seq > ?" : "1 = 1",
    ].join(" and ");
    const order = opts.after !== undefined ? "asc" : "desc";
    const params = [
      ...(names ?? []),
      ...(opts.after !== undefined ? [opts.after] : []),
      opts.limit ?? 100,
    ];
    const rows = this.db
      .prepare(
        `select seq, agent_name, data from activity where ${where} order by seq ${order} limit ?`,
      )
      .all(...params) as { seq: number; agent_name: string; data: string }[];
    return rows.map(
      (r): ActivityRow => ({
        ...(JSON.parse(r.data) as Record<string, unknown>),
        seq: r.seq,
        agentName: r.agent_name,
      }),
    );
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

  // ------------------------------------------------------------------ owner transactions
  saveOwnerTx(tx: { id: string } & Record<string, unknown>) {
    this.db
      .prepare(
        "insert into owner_txs values (?, ?) on conflict(id) do update set data = excluded.data",
      )
      .run(tx.id, json(tx));
  }

  ownerTx<T>(id: string): T | undefined {
    const row = this.db.prepare("select data from owner_txs where id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
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
