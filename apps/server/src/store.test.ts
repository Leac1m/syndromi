// The store's behaviour on both engines: SQLite (always) and Postgres (when
// SYNDROMI_TEST_DATABASE_URL is set). Postgres runs in a throwaway schema that is dropped
// afterwards, so a real database's tables are never touched.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentRecord, type DraftRecord, StatusChanged, Store } from "./db.js";

type Engine = {
  name: string;
  setup(): Promise<void>;
  /** A new Store over the same data (a server restart). */
  open(): Store;
  teardown(): Promise<void>;
};

const sqlite = (): Engine => {
  let dir = "";
  return {
    name: "sqlite",
    async setup() {
      dir = mkdtempSync(join(tmpdir(), "syndromi-store-"));
    },
    open: () => new Store(join(dir, "server.db")),
    async teardown() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const postgres = (url: string): Engine => {
  const schema = `syndromi_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({
      connectionString: url.replace(/sslmode=(prefer|require|verify-ca)/, "sslmode=verify-full"),
    });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  return {
    name: "postgres",
    setup: () => admin(`create schema ${pg.escapeIdentifier(schema)}`),
    open: () => new Store(url, { pgSchema: schema }),
    teardown: () => admin(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`),
  };
};

const engines = [
  sqlite(),
  ...(process.env.SYNDROMI_TEST_DATABASE_URL
    ? [postgres(process.env.SYNDROMI_TEST_DATABASE_URL)]
    : []),
];

const OWNER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" as Address;
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

const agent = (name: string, owner = OWNER): AgentRecord => ({
  name,
  address: OTHER,
  owner,
  cluster: "devnet",
  allowanceMint: MINT,
  rules: { maxTxUsd: 25, approveAboveUsd: 10, destinations: ["self"], programs: ["jupiter"] },
  registeredAt: "2026-10-01T00:00:00.000Z",
});

const draft = (id: string, agentName: string, createdAt: string): DraftRecord => ({
  id,
  agentName,
  agent: OTHER,
  owner: OWNER,
  cluster: "devnet",
  tool: "jupiter-swap",
  input: { amount: 15 },
  intent: { inputAmount: 15_000_000n } as unknown as DraftRecord["intent"],
  decision: { decision: "needs_approval", reasons: ["above $10"], usd: 15 } as never,
  summary: "swap 15 USDC for JitoSOL",
  usd: 15,
  status: "pending",
  createdAt,
  expiresAt: "2026-10-01T01:00:00.000Z",
});

describe.each(engines)("store on $name", (engine) => {
  let store: Store;

  beforeAll(async () => {
    await engine.setup();
    store = engine.open();
    await store.ready;
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await engine.teardown();
  }, 60_000);

  it("keeps agents per owner, merges re-registration, and refuses a change of owner", async () => {
    await store.upsertAgent({ ...agent("a-1"), manifest: { name: "a-1" } });
    await store.upsertAgent(agent("b-1", OTHER));
    // A runtime re-registering must not erase the manifest the server already holds.
    await store.upsertAgent({ ...agent("a-1"), registeredAt: "2026-10-02T00:00:00.000Z" });
    const a1 = await store.agent("a-1");
    expect(a1).toMatchObject({
      manifest: { name: "a-1" },
      registeredAt: "2026-10-01T00:00:00.000Z",
    });
    expect((await store.agents(OWNER)).map((a) => a.name)).toEqual(["a-1"]);
    expect((await store.agents()).map((a) => a.name)).toEqual(["a-1", "b-1"]);
    await expect(store.upsertAgent(agent("a-1", OTHER))).rejects.toThrow(/different owner/);
  });

  it("archives a removed agent's key instead of deleting it", async () => {
    await store.upsertAgent(agent("gone"));
    await store.saveHostedKey("gone", { ciphertext: "x" });
    await store.removeAgent("gone");
    expect(await store.agent("gone")).toBeUndefined();
    expect(await store.hostedKey("gone")).toBeUndefined();
    const archived = await store.sql.all<{ name: string }>(
      "select name from hosted_keys where name like 'removed/gone/%'",
    );
    expect(archived).toHaveLength(1);
  });

  it("uses a login nonce once, and only for its owner", async () => {
    await store.issueLoginNonce("n-1", OWNER, "sign in please");
    expect(await store.consumeLoginNonce("n-1", OTHER)).toBeUndefined();
    const both = await Promise.all([
      store.consumeLoginNonce("n-1", OWNER),
      store.consumeLoginNonce("n-1", OWNER),
    ]);
    expect(both.filter(Boolean)).toEqual(["sign in please"]);
    expect(await store.consumeLoginNonce("unknown", OWNER)).toBeUndefined();
  });

  it("uses a draft sign request once, and only for its draft", async () => {
    await store.issueSignRequest("s-1", "d_1", "approve d_1");
    expect(await store.consumeSignRequest("s-1", "d_other")).toBeUndefined();
    const both = await Promise.all([
      store.consumeSignRequest("s-1", "d_1"),
      store.consumeSignRequest("s-1", "d_1"),
    ]);
    expect(both.filter(Boolean)).toEqual(["approve d_1"]);
  });

  it("expires sessions", async () => {
    await store.createSession("tok", OWNER, "2026-10-01T12:00:00.000Z");
    expect(await store.sessionOwner("tok", new Date("2026-10-01T11:00:00.000Z"))).toBe(OWNER);
    expect(await store.sessionOwner("tok", new Date("2026-10-01T13:00:00.000Z"))).toBeUndefined();
  });

  it("filters drafts, revives bigints, and keeps concurrent patches", async () => {
    await store.saveDraft(draft("d_a", "a-1", "2026-10-01T00:00:02.000Z"));
    await store.saveDraft(draft("d_b", "a-1", "2026-10-01T00:00:01.000Z"));
    await store.saveDraft(draft("d_c", "b-1", "2026-10-01T00:00:03.000Z"));
    expect((await store.drafts({ agentName: "a-1" })).map((d) => d.id)).toEqual(["d_b", "d_a"]);
    expect((await store.draft("d_a"))?.intent).toMatchObject({ inputAmount: 15_000_000n });

    await Promise.all([
      store.updateDraft("d_a", { resultSignature: "sig" }),
      store.updateDraft("d_a", { resultError: "err" }),
    ]);
    expect(await store.draft("d_a")).toMatchObject({ resultSignature: "sig", resultError: "err" });

    await store.updateDraft("d_b", { status: "approved" }, ["pending"]);
    expect((await store.drafts({ status: "approved" })).map((d) => d.id)).toEqual(["d_b"]);
  });

  it("applies a guarded status change once when two race", async () => {
    await store.saveDraft(draft("d_race", "a-1", "2026-10-01T00:00:04.000Z"));
    const results = await Promise.allSettled([
      store.updateDraft("d_race", { status: "approved" }, ["pending"]),
      store.updateDraft("d_race", { status: "expired" }, ["pending"]),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const lost = results[1] as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(StatusChanged);
    expect((await store.draft("d_race"))?.status).toBe("approved");
  });

  it("stores top-ups with bigint amounts", async () => {
    await store.saveTopUp({
      id: "t_1",
      agentName: "a-1",
      agent: OTHER,
      owner: OWNER,
      cluster: "devnet",
      mint: MINT,
      amount: 5_000_000n,
      reason: "weekly allowance used up",
      status: "pending",
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-02T00:00:00.000Z",
    });
    expect((await store.topUp("t_1"))?.amount).toBe(5_000_000n);
    await expect(store.updateTopUp("t_1", { status: "pulled" }, ["approved"])).rejects.toThrow(
      StatusChanged,
    );
    expect((await store.topUps({ status: "pending" })).map((t) => t.id)).toEqual(["t_1"]);
  });

  it("numbers activity in call order and pages through it", async () => {
    await Promise.all(
      [1, 2, 3].map((n) =>
        store.addActivity(n === 2 ? "b-1" : "a-1", {
          type: "note",
          at: `2026-10-01T00:00:0${n}.000Z`,
          n,
        }),
      ),
    );
    const newest = await store.activity({ agentNames: ["a-1", "b-1"] });
    expect(newest.map((e) => e.n)).toEqual([3, 2, 1]);
    expect(typeof newest[0]?.seq).toBe("number");
    const first = newest[2]?.seq ?? 0;
    expect((await store.activity({ after: first })).map((e) => e.n)).toEqual([2, 3]);
    expect((await store.activity({ agentNames: ["b-1"] })).map((e) => e.agentName)).toEqual([
      "b-1",
    ]);
    expect(await store.activity({ agentNames: [] })).toEqual([]);
  });

  it("keeps settings and owner transactions", async () => {
    await store.setSetting("k", "1");
    await store.setSetting("k", "2");
    expect(await store.setting("k")).toBe("2");
    await store.deleteSetting("k");
    expect(await store.setting("k")).toBeUndefined();
    await store.saveOwnerTx({ id: "x_1", status: "issued" });
    expect(await store.ownerTx("x_1")).toEqual({ id: "x_1", status: "issued" });
  });

  it("links Telegram chats to wallets with single-use, expiring codes", async () => {
    await store.issueTelegramCode("c-1", OWNER);
    expect(await store.consumeTelegramCode("nope")).toBeUndefined();
    const both = await Promise.all([
      store.consumeTelegramCode("c-1"),
      store.consumeTelegramCode("c-1"),
    ]);
    expect(both.filter(Boolean)).toEqual([OWNER]);

    await store.issueTelegramCode("c-old", OWNER);
    const later = new Date(Date.now() + 11 * 60 * 1000);
    expect(await store.consumeTelegramCode("c-old", undefined, later)).toBeUndefined();

    // One chat can hold several wallets, and linking twice changes nothing.
    await store.linkTelegram("100", OWNER);
    await store.linkTelegram("100", OWNER);
    await store.linkTelegram("100", OTHER);
    await store.linkTelegram("200", OTHER);
    expect(await store.telegramOwners("100")).toEqual([OWNER, OTHER]);
    expect(await store.telegramChats(OTHER)).toEqual(["100", "200"]);
    expect(await store.telegramChats(OWNER)).toEqual(["100"]);

    expect(await store.unlinkTelegram(OTHER, "200")).toBe(1);
    expect(await store.unlinkTelegram(OTHER, "200")).toBe(0);
    expect(await store.unlinkTelegramChat("100")).toBe(2);
    expect(await store.telegramChats(OWNER)).toEqual([]);
    await store.linkTelegram("300", OWNER);
    await store.linkTelegram("301", OWNER);
    expect(await store.unlinkTelegram(OWNER)).toBe(2);
  });

  it("keeps tokens as hashes, caps the live ones, and revokes on demand", async () => {
    const token = (id: string, expiresAt: string) => ({
      id,
      agentName: "a-1",
      owner: OWNER,
      prefix: "syn_abcd",
      label: "",
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt,
    });
    const now = new Date("2026-10-02T00:00:00.000Z");
    await store.createToken(token("k_1", "2026-11-01T00:00:00.000Z"), "hash-1", now);
    await store.createToken(token("k_2", "2026-11-01T00:00:00.000Z"), "hash-2", now);
    await store.createToken(token("k_old", "2026-10-01T12:00:00.000Z"), "hash-old", now); // already expired
    // Racing creations still respect the cap of three live tokens.
    const raced = await Promise.allSettled([
      store.createToken(token("k_3", "2026-11-01T00:00:00.000Z"), "hash-3", now),
      store.createToken(token("k_4", "2026-11-01T00:00:00.000Z"), "hash-4", now),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);

    expect((await store.tokenByHash("hash-1"))?.id).toBe("k_1");
    expect(await store.tokenByHash("nope")).toBeUndefined();
    expect((await store.tokens("a-1")).length).toBe(4);
    expect(JSON.stringify(await store.tokens("a-1"))).not.toContain("hash-");

    await store.touchToken("k_1", now);
    expect((await store.tokenByHash("hash-1"))?.lastUsedAt).toBe(now.toISOString());
    expect(await store.revokeToken("a-1", "k_1", now)).toBe(true);
    expect(await store.revokeToken("a-1", "k_1", now)).toBe(false);
    expect(await store.revokeToken("b-1", "k_2", now)).toBe(false); // not that agent's token
    expect(await store.revokeTokensOf(["a-1"], now)).toBe(3); // k_2, k_old, and the raced winner
    expect(await store.revokeTokensOf(["a-1"], now)).toBe(0);
  }, 30_000);

  it("still has everything after a restart", async () => {
    const reopened = engine.open();
    try {
      await reopened.ready;
      expect((await reopened.agents()).map((a) => a.name)).toEqual(["a-1", "b-1"]);
      expect((await reopened.draft("d_race"))?.status).toBe("approved");
      expect(await reopened.ownerTx("x_1")).toEqual({ id: "x_1", status: "issued" });
    } finally {
      await reopened.close();
    }
  });
});
