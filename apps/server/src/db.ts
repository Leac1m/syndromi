// The server's store: agents, drafts, top-up requests, activity, and the nonces handed out for
// owner signatures. SQLite (Node's built-in node:sqlite) on a local file by default; Postgres when
// given a postgres:// URL (DATABASE_URL), so a hosted server keeps its data across restarts.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Address } from "@solana/kit";
import type { Cluster, Decision, Intent } from "@syndromi/core";
import pg from "pg";

export type AgentRecord = {
  name: string;
  address: Address;
  owner: Address;
  cluster: Cluster;
  allowanceMint: Address;
  rules: { maxTxUsd: number; approveAboveUsd: number; destinations: string[]; programs: string[] };
  registeredAt: string;
  runtime?: "local" | "hosted" | "external";
  /**
   * Who holds an external agent's key. `server`: encrypted in this server's store, reachable by
   * the owner's AI through /agent (remote MCP or HTTP) with a per-agent token. Otherwise the key
   * is on the owner's machine (`syndromi mcp`).
   */
  custody?: "server" | "local";
  /** As in the manifest: token symbol (or mint), amount per period, period. */
  allowance?: { mint: string; amount: number; period: "daily" | "weekly" | "monthly" };
  feeBudgetSol?: number;
  /** Hosted agents: the full manifest and prompt the server runs (Phase 6). */
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

// One schema for both engines; only the activity sequence column differs.
const schema = (dialect: Dialect) => `
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
  seq ${dialect === "postgres" ? "bigserial primary key" : "integer primary key autoincrement"},
  agent_name text not null, type text not null, at text not null, data text not null);
create table if not exists sign_requests (
  nonce text primary key, draft_id text not null, text text not null, created_at text not null,
  used integer not null default 0);
create table if not exists settings (key text primary key, value text not null);
create table if not exists owner_txs (id text primary key, data text not null);
create table if not exists agent_tokens (
  id text primary key, hash text not null unique, agent_name text not null, owner text not null,
  prefix text not null, label text not null, created_at text not null, last_used_at text,
  expires_at text not null, revoked_at text);
create table if not exists telegram_links (
  chat_id text not null, owner text not null, linked_at text not null,
  primary key (chat_id, owner));
create table if not exists telegram_codes (
  code text primary key, owner text not null, created_at text not null,
  used integer not null default 0);
`;

type Dialect = "sqlite" | "postgres";
type Param = string | number | null;

/** The few query shapes the store needs. Statements use `?` placeholders on both engines. */
export interface Sql {
  readonly dialect: Dialect;
  all<T>(sql: string, params?: Param[]): Promise<T[]>;
  get<T>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<void>;
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

class SqliteSql implements Sql {
  readonly dialect = "sqlite";
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal;");
  }

  async all<T>(sql: string, params: Param[] = []) {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async get<T>(sql: string, params: Param[] = []) {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  async run(sql: string, params: Param[] = []) {
    this.db.prepare(sql).run(...(params as SQLInputValue[]));
  }

  async exec(script: string) {
    this.db.exec(script);
  }

  async close() {
    this.db.close();
  }
}

class PostgresSql implements Sql {
  readonly dialect = "postgres";
  private readonly pool: pg.Pool;

  constructor(url: string, schema?: string) {
    if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(schema)) {
      throw new Error(`not a plain schema name: ${schema}`);
    }
    this.pool = new pg.Pool({
      connectionString: strictSsl(url),
      max: 5,
      idleTimeoutMillis: 30_000,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    // Hosted Postgres (e.g. Neon) closes idle connections when it scales to zero. The pool drops
    // the dead client and reconnects on the next query; without a listener the error would crash
    // the process.
    this.pool.on("error", (err) =>
      console.warn(`postgres: idle connection closed (${err.message})`),
    );
  }

  private async query<T>(sql: string, params: Param[]) {
    let n = 0;
    const text = sql.replace(/\?/g, () => `$${++n}`);
    return (await this.pool.query(text, params)).rows as T[];
  }

  all<T>(sql: string, params: Param[] = []) {
    return this.query<T>(sql, params);
  }

  async get<T>(sql: string, params: Param[] = []) {
    return (await this.query<T>(sql, params))[0];
  }

  async run(sql: string, params: Param[] = []) {
    await this.query(sql, params);
  }

  async exec(script: string) {
    await this.pool.query(script);
  }

  close() {
    return this.pool.end();
  }
}

/**
 * pg verifies the server certificate for sslmode=require today, but its next major version will
 * give `require` libpq's weaker meaning (encrypt, don't verify). Ask for verification explicitly.
 */
function strictSsl(url: string) {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get("sslmode");
  if (mode === "prefer" || mode === "require" || mode === "verify-ca") {
    parsed.searchParams.set("sslmode", "verify-full");
  }
  return parsed.toString();
}

const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** A per-agent access token as stored: only its hash, never the token itself. */
export type TokenRecord = {
  id: string;
  agentName: string;
  owner: string;
  /** The first characters of the token, to tell tokens apart in lists and the activity feed. */
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: string;
  revokedAt?: string;
};

export const MAX_LIVE_TOKENS_PER_AGENT = 3;

/** Creating a token would exceed the live-token limit for the agent. */
export class TokenLimit extends Error {
  constructor() {
    super(`an agent can have at most ${MAX_LIVE_TOKENS_PER_AGENT} live tokens; revoke one first`);
  }
}

type TokenRow = {
  id: string;
  agent_name: string;
  owner: string;
  prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
};

const tokenOf = (r: TokenRow): TokenRecord => ({
  id: r.id,
  agentName: r.agent_name,
  owner: r.owner,
  prefix: r.prefix,
  label: r.label,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
});

const TOKEN_COLUMNS =
  "id, agent_name, owner, prefix, label, created_at, last_used_at, expires_at, revoked_at";

/** How long a Telegram link code stays valid. */
export const TELEGRAM_CODE_TTL_MS = 10 * 60 * 1000;

/** A guarded update found the record in another status (someone else changed it first). */
export class StatusChanged extends Error {
  constructor(
    kind: "draft" | "top-up",
    readonly status: DraftStatus | TopUpStatus,
  ) {
    super(`${kind} is ${status}`);
  }
}

export class Store {
  /** The underlying engine, for tests and one-off reads. */
  readonly sql: Sql;
  /** Resolves once the schema exists; rejects if the database can't be reached. */
  readonly ready: Promise<void>;
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * `target`: a postgres:// (or postgresql://) URL, a SQLite file path, or ":memory:".
   * `pgSchema`: keep the tables in this (existing) Postgres schema instead of `public`.
   */
  constructor(target: string, opts: { pgSchema?: string } = {}) {
    this.sql = /^postgres(ql)?:\/\//.test(target)
      ? new PostgresSql(target, opts.pgSchema)
      : new SqliteSql(target);
    this.ready = this.sql.exec(schema(this.sql.dialect));
    this.ready.catch(() => undefined); // reported by whoever awaits it
  }

  close() {
    return this.sql.close();
  }

  private async all<T>(sql: string, params?: Param[]) {
    await this.ready;
    return this.sql.all<T>(sql, params);
  }

  private async get<T>(sql: string, params?: Param[]) {
    await this.ready;
    return this.sql.get<T>(sql, params);
  }

  private async run(sql: string, params?: Param[]) {
    await this.ready;
    await this.sql.run(sql, params);
  }

  /**
   * Run read-modify-write steps for one key one at a time. Store calls are async, so two updates
   * to the same draft could otherwise interleave and one patch would be lost. One server process
   * owns the database, so an in-process lock is enough.
   */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }

  // ------------------------------------------------------------------ agents
  upsertAgent(agent: AgentRecord) {
    return this.serialize(`agent:${agent.name}`, async () => {
      const previous = await this.agent(agent.name);
      // Registration from a runtime must not erase what the server already knows (e.g. a hosted
      // agent's manifest), and never moves an agent to a different owner.
      if (previous && previous.owner !== agent.owner) {
        throw new Error(`agent ${agent.name} belongs to a different owner`);
      }
      // The address is the agent's identity: allowances are granted to it and (for server-held
      // agents) the loaded key must match it. A new key under the same name needs the old agent
      // removed first, which also requires its delegations to be revoked.
      if (previous && previous.address !== agent.address) {
        throw new Error(
          `agent ${agent.name} is already registered with a different address; remove it first`,
        );
      }
      const merged = {
        ...previous,
        ...agent,
        registeredAt: previous?.registeredAt ?? agent.registeredAt,
      };
      await this.run(
        `insert into agent_records values (?, ?, ?)
         on conflict(name) do update set owner = excluded.owner, data = excluded.data`,
        [agent.name, agent.owner, json(merged)],
      );
    });
  }

  async agent(name: string): Promise<AgentRecord | undefined> {
    const row = await this.get<{ data: string }>("select data from agent_records where name = ?", [
      name,
    ]);
    return row ? (JSON.parse(row.data) as AgentRecord) : undefined;
  }

  async agents(owner?: string): Promise<AgentRecord[]> {
    const rows =
      owner === undefined
        ? await this.all<{ data: string }>("select data from agent_records order by name")
        : await this.all<{ data: string }>(
            "select data from agent_records where owner = ? order by name",
            [owner],
          );
    return rows.map((r) => JSON.parse(r.data) as AgentRecord);
  }

  /**
   * Remove an agent's record. A hosted key is archived under `removed/<name>/<time>`, never
   * deleted: its wallet may still hold SOL or tokens.
   */
  async removeAgent(name: string) {
    await this.run("update hosted_keys set name = ? where name = ?", [
      `removed/${name}/${new Date().toISOString()}`,
      name,
    ]);
    await this.run("delete from agent_records where name = ?", [name]);
    await this.revokeTokensOf([name]);
  }

  async saveHostedKey(name: string, encrypted: unknown) {
    await this.run(
      "insert into hosted_keys values (?, ?) on conflict(name) do update set data = excluded.data",
      [name, JSON.stringify(encrypted)],
    );
  }

  async hostedKey(name: string): Promise<unknown> {
    const row = await this.get<{ data: string }>("select data from hosted_keys where name = ?", [
      name,
    ]);
    return row ? JSON.parse(row.data) : undefined;
  }

  // ------------------------------------------------------------------ owner sessions
  async issueLoginNonce(nonce: string, owner: string, text: string) {
    await this.run(
      "insert into login_nonces (nonce, owner, text, created_at) values (?, ?, ?, ?)",
      [nonce, owner, text, new Date().toISOString()],
    );
  }

  /** Marks the nonce used in the same statement that reads it, so it works exactly once. */
  async consumeLoginNonce(nonce: string, owner: string): Promise<string | undefined> {
    const row = await this.get<{ text: string }>(
      "update login_nonces set used = 1 where nonce = ? and owner = ? and used = 0 returning text",
      [nonce, owner],
    );
    return row?.text;
  }

  async createSession(token: string, owner: string, expiresAt: string) {
    await this.run("insert into sessions values (?, ?, ?)", [token, owner, expiresAt]);
  }

  async sessionOwner(token: string, now = new Date()): Promise<string | undefined> {
    const row = await this.get<{ owner: string; expires_at: string }>(
      "select owner, expires_at from sessions where token = ?",
      [token],
    );
    if (!row || Date.parse(row.expires_at) < now.getTime()) return undefined;
    return row.owner;
  }

  // ------------------------------------------------------------------ drafts
  async saveDraft(draft: DraftRecord) {
    await this.run(
      `insert into drafts values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set status = excluded.status, data = excluded.data`,
      [draft.id, draft.agentName, draft.status, draft.createdAt, draft.expiresAt, json(draft)],
    );
  }

  async draft(id: string): Promise<DraftRecord | undefined> {
    const row = await this.get<{ data: string }>("select data from drafts where id = ?", [id]);
    return row ? reviveDraft(row.data) : undefined;
  }

  async drafts(filter: { agentName?: string; status?: DraftStatus } = {}): Promise<DraftRecord[]> {
    const rows = await this.all<{ data: string }>(
      ...filtered("drafts", { agent_name: filter.agentName, status: filter.status }),
    );
    return rows.map((r) => reviveDraft(r.data));
  }

  /** With `from`, the update applies only while the draft is in one of those statuses. */
  updateDraft(id: string, patch: Partial<DraftRecord>, from?: DraftStatus[]): Promise<DraftRecord> {
    return this.serialize(`draft:${id}`, async () => {
      const current = await this.draft(id);
      if (!current) throw new Error(`no draft ${id}`);
      if (from && !from.includes(current.status)) throw new StatusChanged("draft", current.status);
      const next = { ...current, ...patch };
      await this.saveDraft(next);
      return next;
    });
  }

  // ------------------------------------------------------------------ top-ups
  async saveTopUp(topup: TopUpRecord) {
    await this.run(
      `insert into topups values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set status = excluded.status, data = excluded.data`,
      [topup.id, topup.agentName, topup.status, topup.createdAt, topup.expiresAt, json(topup)],
    );
  }

  async topUp(id: string): Promise<TopUpRecord | undefined> {
    const row = await this.get<{ data: string }>("select data from topups where id = ?", [id]);
    return row ? reviveTopUp(row.data) : undefined;
  }

  async topUps(filter: { agentName?: string; status?: TopUpStatus } = {}): Promise<TopUpRecord[]> {
    const rows = await this.all<{ data: string }>(
      ...filtered("topups", { agent_name: filter.agentName, status: filter.status }),
    );
    return rows.map((r) => reviveTopUp(r.data));
  }

  /** With `from`, the update applies only while the top-up is in one of those statuses. */
  updateTopUp(id: string, patch: Partial<TopUpRecord>, from?: TopUpStatus[]): Promise<TopUpRecord> {
    return this.serialize(`topup:${id}`, async () => {
      const current = await this.topUp(id);
      if (!current) throw new Error(`no top-up ${id}`);
      if (from && !from.includes(current.status)) throw new StatusChanged("top-up", current.status);
      const next = { ...current, ...patch };
      await this.saveTopUp(next);
      return next;
    });
  }

  // ------------------------------------------------------------------ activity
  /** Events are written one at a time, so the feed's sequence follows the order of calls. */
  addActivity(agentName: string, event: { type: string; at: string } & Record<string, unknown>) {
    return this.serialize("activity", () =>
      this.run("insert into activity (agent_name, type, at, data) values (?, ?, ?, ?)", [
        agentName,
        event.type,
        event.at,
        json(event),
      ]),
    );
  }

  /** Newest first, or (with `after`) everything newer than a sequence number, oldest first. */
  async activity(
    opts: { agentNames?: string[]; after?: number; limit?: number } = {},
  ): Promise<ActivityRow[]> {
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
    const rows = await this.all<{ seq: number | string; agent_name: string; data: string }>(
      `select seq, agent_name, data from activity where ${where} order by seq ${order} limit ?`,
      params,
    );
    return rows.map(
      (r): ActivityRow => ({
        ...(JSON.parse(r.data) as Record<string, unknown>),
        seq: Number(r.seq), // Postgres returns bigserial values as strings
        agentName: r.agent_name,
      }),
    );
  }

  // ------------------------------------------------------------------ signing nonces
  async issueSignRequest(nonce: string, draftId: string, text: string) {
    await this.run(
      "insert into sign_requests (nonce, draft_id, text, created_at) values (?, ?, ?, ?)",
      [nonce, draftId, text, new Date().toISOString()],
    );
  }

  /** Returns the issued text and marks the nonce used, or undefined if unknown/used/mismatched. */
  async consumeSignRequest(nonce: string, draftId: string): Promise<string | undefined> {
    const row = await this.get<{ text: string }>(
      "update sign_requests set used = 1 where nonce = ? and draft_id = ? and used = 0 returning text",
      [nonce, draftId],
    );
    return row?.text;
  }

  // ------------------------------------------------------------------ owner transactions
  async saveOwnerTx(tx: { id: string } & Record<string, unknown>) {
    await this.run(
      "insert into owner_txs values (?, ?) on conflict(id) do update set data = excluded.data",
      [tx.id, json(tx)],
    );
  }

  async ownerTx<T>(id: string): Promise<T | undefined> {
    const row = await this.get<{ data: string }>("select data from owner_txs where id = ?", [id]);
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  // ------------------------------------------------------------------ agent tokens
  /** Store a token's hash. Throws TokenLimit when the agent already has the maximum live. */
  createToken(token: TokenRecord, hash: string, now = new Date()) {
    return this.serialize(`tokens:${token.agentName}`, async () => {
      const live = await this.get<{ n: number | string }>(
        "select count(*) as n from agent_tokens where agent_name = ? and revoked_at is null and expires_at > ?",
        [token.agentName, now.toISOString()],
      );
      if (Number(live?.n ?? 0) >= MAX_LIVE_TOKENS_PER_AGENT) throw new TokenLimit();
      await this.run(
        `insert into agent_tokens (id, hash, agent_name, owner, prefix, label, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          token.id,
          hash,
          token.agentName,
          token.owner,
          token.prefix,
          token.label,
          token.createdAt,
          token.expiresAt,
        ],
      );
    });
  }

  async tokenByHash(hash: string): Promise<TokenRecord | undefined> {
    const row = await this.get<TokenRow>(
      `select ${TOKEN_COLUMNS} from agent_tokens where hash = ?`,
      [hash],
    );
    return row ? tokenOf(row) : undefined;
  }

  /** Every token of an agent, newest first (revoked and expired ones included, for display). */
  async tokens(agentName: string): Promise<TokenRecord[]> {
    const rows = await this.all<TokenRow>(
      `select ${TOKEN_COLUMNS} from agent_tokens where agent_name = ? order by created_at desc`,
      [agentName],
    );
    return rows.map(tokenOf);
  }

  async touchToken(id: string, now = new Date()) {
    await this.run("update agent_tokens set last_used_at = ? where id = ?", [
      now.toISOString(),
      id,
    ]);
  }

  /** True if the token was live and is now revoked. */
  async revokeToken(agentName: string, id: string, now = new Date()): Promise<boolean> {
    const rows = await this.all<{ id: string }>(
      `update agent_tokens set revoked_at = ?
       where id = ? and agent_name = ? and revoked_at is null returning id`,
      [now.toISOString(), id, agentName],
    );
    return rows.length > 0;
  }

  /** Revoke every live token of these agents (kill switch, agent removal). Returns how many. */
  async revokeTokensOf(agentNames: string[], now = new Date()): Promise<number> {
    let revoked = 0;
    for (const name of agentNames) {
      const rows = await this.all<{ id: string }>(
        "update agent_tokens set revoked_at = ? where agent_name = ? and revoked_at is null returning id",
        [now.toISOString(), name],
      );
      revoked += rows.length;
    }
    return revoked;
  }

  // ------------------------------------------------------------------ telegram
  /** A one-time code that binds whichever chat presents it to `owner`'s wallet. */
  async issueTelegramCode(code: string, owner: string) {
    await this.run("insert into telegram_codes (code, owner, created_at) values (?, ?, ?)", [
      code,
      owner,
      new Date().toISOString(),
    ]);
  }

  /** The wallet a code was issued for. Works once; undefined if unknown, used or older than `ttlMs`. */
  async consumeTelegramCode(
    code: string,
    ttlMs = TELEGRAM_CODE_TTL_MS,
    now = new Date(),
  ): Promise<string | undefined> {
    const row = await this.get<{ owner: string; created_at: string }>(
      "update telegram_codes set used = 1 where code = ? and used = 0 returning owner, created_at",
      [code],
    );
    if (!row || now.getTime() - Date.parse(row.created_at) > ttlMs) return undefined;
    return row.owner;
  }

  /** One chat may link several wallets; linking the same pair again changes nothing. */
  async linkTelegram(chatId: string, owner: string) {
    await this.run(
      "insert into telegram_links (chat_id, owner, linked_at) values (?, ?, ?) on conflict do nothing",
      [chatId, owner, new Date().toISOString()],
    );
  }

  /** Unlink one chat from `owner` (or, without a chat, every chat). Returns how many were removed. */
  async unlinkTelegram(owner: string, chatId?: string): Promise<number> {
    const rows =
      chatId === undefined
        ? await this.all<{ chat_id: string }>(
            "delete from telegram_links where owner = ? returning chat_id",
            [owner],
          )
        : await this.all<{ chat_id: string }>(
            "delete from telegram_links where owner = ? and chat_id = ? returning chat_id",
            [owner, chatId],
          );
    return rows.length;
  }

  /** Unlink a chat from every wallet (the bot's /unlink). */
  async unlinkTelegramChat(chatId: string): Promise<number> {
    const rows = await this.all<{ owner: string }>(
      "delete from telegram_links where chat_id = ? returning owner",
      [chatId],
    );
    return rows.length;
  }

  async telegramChats(owner: string): Promise<string[]> {
    const rows = await this.all<{ chat_id: string }>(
      "select chat_id from telegram_links where owner = ? order by linked_at, chat_id",
      [owner],
    );
    return rows.map((r) => r.chat_id);
  }

  async telegramOwners(chatId: string): Promise<string[]> {
    const rows = await this.all<{ owner: string }>(
      "select owner from telegram_links where chat_id = ? order by linked_at, owner",
      [chatId],
    );
    return rows.map((r) => r.owner);
  }

  // ------------------------------------------------------------------ settings
  async setting(key: string): Promise<string | undefined> {
    const row = await this.get<{ value: string }>("select value from settings where key = ?", [
      key,
    ]);
    return row?.value;
  }

  async setSetting(key: string, value: string) {
    await this.run(
      "insert into settings values (?, ?) on conflict(key) do update set value = excluded.value",
      [key, value],
    );
  }

  async deleteSetting(key: string) {
    await this.run("delete from settings where key = ?", [key]);
  }
}

/** `select data from <table>` with optional equality filters, oldest first. */
function filtered(
  table: "drafts" | "topups",
  where: Record<string, string | undefined>,
): [string, Param[]] {
  const set = Object.entries(where).filter((e): e is [string, string] => e[1] !== undefined);
  const clause = set.length ? ` where ${set.map(([column]) => `${column} = ?`).join(" and ")}` : "";
  return [`select data from ${table}${clause} order by created_at`, set.map(([, v]) => v)];
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
