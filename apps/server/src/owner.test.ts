import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import { decryptKeypair, type EncryptedKeypair, findToken } from "@syndromi/core";
import { fakeRpc } from "@syndromi/tools/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createContext, type ServerContext } from "./context.js";
import { Store } from "./db.js";

const SECRET = "a-test-secret-that-is-at-least-32-chars";
let ctx: ServerContext;
let app: ReturnType<typeof createApp>;
let alice: KeyPairSigner;
let bob: KeyPairSigner;

const req = (path: string, opts: { body?: unknown; token?: string; method?: string } = {}) =>
  app.request(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

async function signInAs(who: KeyPairSigner) {
  const { nonce, text } = (await (
    await req("/owner/session/challenge", { body: { owner: who.address } })
  ).json()) as {
    nonce: string;
    text: string;
  };
  const signature = getBase58Decoder().decode(
    await signBytes(who.keyPair.privateKey, getUtf8Encoder().encode(text)),
  );
  const res = await req("/owner/session", { body: { owner: who.address, nonce, signature } });
  return { res, nonce, text, signature };
}

beforeEach(async () => {
  alice = await generateKeyPairSigner();
  bob = await generateKeyPairSigner();
  ctx = createContext(new Store(":memory:"), {
    publicUrl: "http://localhost:8787",
    token: "t",
    env: { SYNDROMI_HOSTED_SECRET: SECRET },
    draftTtlMs: 60_000,
    topUpTtlMs: 60_000,
    dashboardOrigins: ["http://localhost:3000"],
  });
  app = createApp(ctx);
});

describe("owner sign-in", () => {
  it("issues a session for a valid signature and refuses replays, strangers, and no session", async () => {
    const { res, nonce, text, signature } = await signInAs(alice);
    expect(res.status).toBe(200);
    const session = (await res.json()) as { token: string; owner: string };
    expect(session.owner).toBe(alice.address);
    expect(text).toMatch(/sends no transaction/);

    const replay = await req("/owner/session", {
      body: { owner: alice.address, nonce, signature },
    });
    expect(replay.status).toBe(401);

    const { nonce: n2, text: t2 } = (await (
      await req("/owner/session/challenge", { body: { owner: alice.address } })
    ).json()) as { nonce: string; text: string };
    const bySomeoneElse = getBase58Decoder().decode(
      await signBytes(bob.keyPair.privateKey, getUtf8Encoder().encode(t2)),
    );
    const forged = await req("/owner/session", {
      body: { owner: alice.address, nonce: n2, signature: bySomeoneElse },
    });
    expect(await forged.json()).toMatchObject({ error: "signature does not match the address" });

    expect((await req("/owner/templates")).status).toBe(401);
    expect((await req("/owner/templates", { token: session.token })).status).toBe(200);
  });

  it("allows the dashboard origin via CORS", async () => {
    const pre = await req("/owner/overview", { method: "OPTIONS" });
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});

describe("owner-scoped data", () => {
  it("creates hosted agents with an encrypted key that never leaves the server", async () => {
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    const templates = (await (await req("/owner/templates", { token })).json()) as {
      name: string;
      manifest: Record<string, unknown>;
      ruleCard: string[];
    }[];
    const scout = templates.find((t) => t.name === "yield-scout");
    expect(scout?.ruleCard[0]).toMatch(/up to 50 USDC per week/);
    // The default template, for agents you already have, leads the wizard; it cannot be hosted.
    expect(templates[0]?.name).toBe("mcp-agent");
    expect(templates[0]?.manifest.runtime).toBe("external");
    const hostedExternal = await req("/owner/agents", {
      token,
      body: { template: "mcp-agent", cluster: "devnet", manifest: templates[0]?.manifest },
    });
    expect(hostedExternal.status).toBe(400);

    const created = await req("/owner/agents", {
      token,
      body: {
        template: "yield-scout",
        cluster: "devnet",
        manifest: {
          ...scout?.manifest,
          name: "scout-1",
          allowance: { mint: "USDC", amount: 30, period: "weekly" },
        },
      },
    });
    expect(created.status).toBe(200);
    const agent = (await created.json()) as Record<string, unknown>;
    expect(agent).toMatchObject({ name: "scout-1", runtime: "hosted", cluster: "devnet" });
    expect(JSON.stringify(agent)).not.toMatch(/ciphertext|secret/i);
    expect((agent.ruleCard as string[])[0]).toMatch(/up to 30 USDC per week/);

    const stored = (await ctx.store.hostedKey("scout-1")) as EncryptedKeypair;
    const decrypted = await decryptKeypair(stored, SECRET);
    expect(decrypted.signer.address).toBe(agent.address);

    const preview = (await (
      await req("/owner/preview", {
        token,
        body: {
          manifest: {
            ...scout?.manifest,
            permissions: { ...(scout?.manifest.permissions as object), approve_above_usd: 40 },
          },
        },
      })
    ).json()) as { ok: boolean; errors: string[] };
    expect(preview.ok).toBe(false);
    expect(preview.errors.join()).toMatch(/approve_above_usd.*must not exceed max_tx_usd/);

    const invalid = await req("/owner/agents", {
      token,
      body: { template: "yield-scout", manifest: { ...scout?.manifest, name: "Bad Name" } },
    });
    expect(invalid.status).toBe(400);
  });

  it("never shows one owner another owner's agents or activity", async () => {
    await ctx.store.upsertAgent({
      name: "bobs-agent",
      address: (await generateKeyPairSigner()).address,
      owner: bob.address as Address,
      cluster: "devnet",
      allowanceMint: "8wvXYteqfNieCn4RVC8rnDSGgugHkMbPT4x8KnMeneVd" as Address,
      rules: { maxTxUsd: 25, approveAboveUsd: 10, destinations: ["self"], programs: ["jupiter"] },
      registeredAt: new Date().toISOString(),
    });
    await ctx.store.addActivity("bobs-agent", {
      type: "blocked",
      at: new Date().toISOString(),
      reasons: ["x"],
    });
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    expect((await req("/owner/agents/bobs-agent", { token })).status).toBe(404);
    const activity = (await (await req("/owner/activity", { token })).json()) as {
      events: unknown[];
    };
    expect(activity.events).toEqual([]);
    const bobs = await ctx.store.agent("bobs-agent");
    await expect(
      ctx.store.upsertAgent({ ...(bobs as NonNullable<typeof bobs>), owner: alice.address }),
    ).rejects.toThrow(/different owner/);
    // Bob's agent cannot be run by Alice either.
    expect((await req("/owner/agents/bobs-agent/run", { token, body: {} })).status).toBe(404);
  });
});

describe("hosted agents: deploy and run now", () => {
  const scout = async (token: string) => {
    const templates = (await (await req("/owner/templates", { token })).json()) as {
      name: string;
      manifest: Record<string, unknown>;
      prompt: string;
    }[];
    const t = templates.find((x) => x.name === "yield-scout");
    if (!t) throw new Error("no yield-scout template");
    return t;
  };

  it("deploys through the runtime API only with the server token", async () => {
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    const t = await scout(token);
    const body = {
      manifest: { ...t.manifest, name: "scout-deployed" },
      prompt: t.prompt,
      owner: alice.address,
      cluster: "fork",
    };
    const api = (auth?: string, b: unknown = body) =>
      app.request("/api/deploy", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(b),
      });
    expect((await api()).status).toBe(401);
    expect((await api("t", { ...body, owner: "nope" })).status).toBe(400);
    const ok = await api("t");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: "scout-deployed", cluster: "fork" });
    expect(await ctx.store.agent("scout-deployed")).toMatchObject({
      runtime: "hosted",
      owner: alice.address,
    });
    expect((await api("t")).status).toBe(409); // the name is taken
  });

  it("runs only the owner's hosted agents, and says when the hosted runtime is off", async () => {
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    const t = await scout(token);
    await req("/owner/agents", {
      token,
      body: { template: "yield-scout", cluster: "devnet", manifest: t.manifest },
    });
    expect((await req("/owner/agents/yield-scout/run", { token, body: {} })).status).toBe(503);
    const runs: string[] = [];
    ctx.hosted = { scan: () => undefined, runNow: (name) => (runs.push(name), true) };
    const run = await req("/owner/agents/yield-scout/run", { token, body: {} });
    expect(await run.json()).toEqual({ started: true });
    expect(runs).toEqual(["yield-scout"]);
  });

  it("removes an unfunded agent, archiving its hosted key, and refuses when it can't be sure", async () => {
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    const t = await scout(token);
    await req("/owner/agents", {
      token,
      body: { template: "yield-scout", cluster: "devnet", manifest: t.manifest },
    });
    const unloaded: string[] = [];
    ctx.hosted = {
      scan: () => undefined,
      runNow: () => true,
      unload: (name) => void unloaded.push(name),
    };
    const remove = (who = token) =>
      req("/owner/agents/yield-scout", { token: who, method: "DELETE" });

    ctx.rpc = () => {
      throw new Error("RPC down");
    };
    expect((await remove()).status).toBe(502); // can't see its delegations: keep it

    ctx.rpc = () => fakeRpc() as never; // no delegations
    const bobSession = await signInAs(bob);
    const bobToken = ((await bobSession.res.json()) as { token: string }).token;
    expect((await remove(bobToken)).status).toBe(404);

    const ok = await remove();
    expect(await ok.json()).toEqual({ removed: "yield-scout" });
    expect(unloaded).toEqual(["yield-scout"]);
    expect(await ctx.store.agent("yield-scout")).toBeUndefined();
    expect(await ctx.store.hostedKey("yield-scout")).toBeUndefined();
    // The key is archived, not gone: its wallet may still hold the fee budget.
    const archived = await ctx.store.sql.all(
      "select name from hosted_keys where name like 'removed/yield-scout/%'",
    );
    expect(archived).toHaveLength(1);
    // The name is free again.
    const again = await req("/owner/agents", {
      token,
      body: { template: "yield-scout", cluster: "devnet", manifest: t.manifest },
    });
    expect(again.status).toBe(200);
  });
});

describe("test-token faucet", () => {
  const TEST_USDC = findToken("USDC", "devnet")?.mints.devnet;
  /** An RPC on which the treasury's transaction lands (or, with `fail`, is never accepted). */
  const landing = (fail = false) => {
    const sent: string[] = [];
    const rpc = fakeRpc({
      sendTransaction: (wire) => {
        if (fail) throw new Error("node is behind");
        sent.push(String(wire));
        return "sig";
      },
      getSignatureStatuses: () => ({
        value: [fail ? null : { confirmationStatus: "confirmed", err: null }],
      }),
    });
    return { rpc, sent };
  };
  const session = async (who: KeyPairSigner) =>
    ((await (await signInAs(who)).res.json()) as { token: string }).token;

  it("is off without a treasury, and the overview does not offer it", async () => {
    const token = await session(alice);
    ctx.rpc = () => fakeRpc() as never;
    const res = await req("/owner/faucet", { token, body: {} });
    expect(res.status).toBe(503);
    const overview = (await (await req("/owner/overview?cluster=devnet", { token })).json()) as {
      faucet?: unknown;
      bag: { symbol: string; usdcMint: string };
    };
    expect(overview.faucet).toBeUndefined();
    expect(overview.bag).toMatchObject({ symbol: "USDC", usdcMint: TEST_USDC });
  });

  it("mints test USDC to the signed-in wallet once a day", async () => {
    ctx.treasury = await generateKeyPairSigner();
    const { rpc, sent } = landing();
    ctx.rpc = () => rpc as never;
    const token = await session(alice);
    expect((await req("/owner/faucet", { body: {} })).status).toBe(401);

    const before = (await (await req("/owner/overview?cluster=devnet", { token })).json()) as {
      faucet: { amount: number; nextAt: string | null };
    };
    expect(before.faucet).toEqual({ amount: 100, nextAt: null });
    // Only devnet has test tokens.
    const mainnet = (await (await req("/owner/overview?cluster=mainnet", { token })).json()) as {
      faucet?: unknown;
    };
    expect(mainnet.faucet).toBeUndefined();

    const res = await req("/owner/faucet", { token, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, amount: 100, symbol: "USDC" });
    expect(sent).toHaveLength(1);

    const again = await req("/owner/faucet", { token, body: {} });
    expect(again.status).toBe(429);
    const body = (await again.json()) as { error: string; nextAt: string };
    expect(body.error).toMatch(/already claimed/);
    expect(Date.parse(body.nextAt)).toBeGreaterThan(Date.now());
    expect(sent).toHaveLength(1);
    const after = (await (await req("/owner/overview?cluster=devnet", { token })).json()) as {
      faucet: { nextAt: string | null };
    };
    expect(after.faucet.nextAt).toBe(body.nextAt);

    // Another wallet has its own claim.
    const bobs = await req("/owner/faucet", { token: await session(bob), body: {} });
    expect(bobs.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("does not use up the day's claim when the mint fails", async () => {
    ctx.treasury = await generateKeyPairSigner();
    ctx.rpc = () => landing(true).rpc as never;
    const token = await session(alice);
    const failed = await req("/owner/faucet", { token, body: {} });
    expect(failed.status).toBe(502);
    // The reason is logged, not shown: it could name the RPC endpoint.
    expect(((await failed.json()) as { error: string }).error).not.toMatch(/node is behind/);

    ctx.rpc = () => landing().rpc as never;
    expect((await req("/owner/faucet", { token, body: {} })).status).toBe(200);
  });
});

describe("Connect Telegram", () => {
  const linkFor = async (owner: string) => ({
    url: `https://t.me/syndromi_bot?start=code-for-${owner.slice(0, 4)}`,
    expiresAt: "2026-10-02T00:10:00.000Z",
  });

  it("needs a session, and reports whether the server has a bot", async () => {
    expect((await req("/owner/telegram")).status).toBe(401);
    expect((await req("/owner/telegram/link", { body: {} })).status).toBe(401);
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    expect(await (await req("/owner/telegram", { token })).json()).toEqual({
      enabled: false,
      chats: 0,
    });
    expect((await req("/owner/telegram/link", { token, body: {} })).status).toBe(503);
  });

  it("issues a link for the signed-in wallet, counts its chats, and disconnects only them", async () => {
    ctx.telegram = { linkUrlFor: linkFor } as never;
    const { res } = await signInAs(alice);
    const { token } = (await res.json()) as { token: string };
    const link = (await (await req("/owner/telegram/link", { token, body: {} })).json()) as {
      url: string;
    };
    expect(link.url).toContain(`code-for-${alice.address.slice(0, 4)}`);

    await ctx.store.linkTelegram("100", alice.address);
    await ctx.store.linkTelegram("200", alice.address);
    await ctx.store.linkTelegram("100", bob.address);
    expect(await (await req("/owner/telegram", { token })).json()).toEqual({
      enabled: true,
      chats: 2,
    });
    expect(await (await req("/owner/telegram", { token, method: "DELETE" })).json()).toEqual({
      unlinked: 2,
    });
    expect(await ctx.store.telegramChats(alice.address)).toEqual([]);
    expect(await ctx.store.telegramChats(bob.address)).toEqual(["100"]);
  });
});

describe("server-held agents and their tokens", () => {
  const SECRET_PREFIX = "syn_";
  const signedIn = async (who = alice) => {
    const { res } = await signInAs(who);
    return ((await res.json()) as { token: string }).token;
  };
  const mcpTemplate = async (token: string) => {
    const templates = (await (await req("/owner/templates", { token })).json()) as {
      name: string;
      manifest: Record<string, unknown>;
    }[];
    const t = templates.find((x) => x.name === "mcp-agent");
    if (!t) throw new Error("no mcp-agent template");
    return t;
  };
  const create = (token: string, body: Record<string, unknown>) =>
    req("/owner/agents", { token, body });

  it("creates an external agent whose key the server holds, on devnet only", async () => {
    const token = await signedIn();
    const t = await mcpTemplate(token);
    const body = { template: "mcp-agent", manifest: t.manifest, custody: "server" };

    const fork = await create(token, { ...body, cluster: "fork" });
    expect(fork.status).toBe(400);
    expect(await fork.json()).toMatchObject({ error: expect.stringContaining("devnet only") });

    const ok = await create(token, { ...body, cluster: "devnet" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      name: "mcp-agent",
      runtime: "external",
      custody: "server",
    });
    expect(await ctx.store.agent("mcp-agent")).toMatchObject({
      runtime: "external",
      custody: "server",
    });
    expect(await ctx.store.hostedKey("mcp-agent")).toBeDefined(); // encrypted, held here

    // Only external templates can be server-held (the others run their own model).
    const yieldScout = await create(token, {
      template: "yield-scout",
      cluster: "devnet",
      custody: "server",
      manifest: { ...t.manifest, name: "other" },
    });
    expect(yieldScout.status).toBe(400);
  });

  it("limits how many agents one owner can create", async () => {
    const token = await signedIn();
    const t = await mcpTemplate(token);
    for (let i = 1; i <= 5; i++) {
      const res = await create(token, {
        template: "mcp-agent",
        cluster: "devnet",
        custody: "server",
        manifest: { ...t.manifest, name: `agent-${i}` },
      });
      expect(res.status).toBe(200);
    }
    const sixth = await create(token, {
      template: "mcp-agent",
      cluster: "devnet",
      custody: "server",
      manifest: { ...t.manifest, name: "agent-6" },
    });
    expect(sixth.status).toBe(409);
    // Another owner is unaffected.
    const bobToken = await signedIn(bob);
    const bobs = await create(bobToken, {
      template: "mcp-agent",
      cluster: "devnet",
      custody: "server",
      manifest: { ...t.manifest, name: "bobs-1" },
    });
    expect(bobs.status).toBe(200);
    // Six keys are encrypted with scrypt here, which sits right at the default 5 s limit.
  }, 20_000);

  it("creates, lists and revokes tokens for the owner's agent only", async () => {
    const token = await signedIn();
    const t = await mcpTemplate(token);
    await create(token, {
      template: "mcp-agent",
      cluster: "devnet",
      custody: "server",
      manifest: t.manifest,
    });
    const tokens = (body: unknown = undefined, who = token, id = "") =>
      req(`/owner/agents/mcp-agent/tokens${id}`, {
        token: who,
        ...(body !== undefined ? { body } : {}),
        ...(id ? { method: "DELETE" } : {}),
      });

    // Lifetimes come from the fixed list; the default is 30 days.
    expect((await tokens({ days: 365 })).status).toBe(400);
    const created = await tokens({ label: "my claude", days: 7 });
    expect(created.status).toBe(201);
    const first = (await created.json()) as {
      token: string;
      id: string;
      prefix: string;
      expiresAt: string;
    };
    expect(first.token.startsWith(SECRET_PREFIX)).toBe(true);
    expect(first.prefix).toBe(first.token.slice(0, 8));
    const days = (Date.parse(first.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const defaulted = (await (await tokens({})).json()) as { expiresAt: string };
    expect((Date.parse(defaulted.expiresAt) - Date.now()) / 86_400_000).toBeGreaterThan(29.9);

    // The list never carries the secret.
    const listed = await (await tokens()).text();
    expect(listed).toContain(first.id);
    expect(listed).not.toContain(first.token);
    expect(listed).not.toContain("hash");

    // A fourth live token is refused until one is revoked.
    await tokens({});
    expect((await tokens({})).status).toBe(409);
    expect((await tokens(undefined, token, `/${first.id}`)).status).toBe(200);
    expect((await tokens(undefined, token, `/${first.id}`)).status).toBe(404); // already revoked
    expect((await tokens({})).status).toBe(201);

    // Another owner can neither see nor create nor revoke them.
    const bobToken = await signedIn(bob);
    expect((await tokens(undefined, bobToken)).status).toBe(404);
    expect((await tokens({}, bobToken)).status).toBe(404);

    // Token events land in the owner's feed, by prefix only.
    const feed = JSON.stringify(await ctx.store.activity({ agentNames: ["mcp-agent"] }));
    expect(feed).toContain("created");
    expect(feed).not.toContain(first.token);
  });

  it("offers no tokens for an agent that holds its own key", async () => {
    const token = await signedIn();
    await ctx.store.upsertAgent({
      name: "local-one",
      address: (await generateKeyPairSigner()).address,
      owner: alice.address,
      cluster: "devnet",
      allowanceMint: "8wvXYteqfNieCn4RVC8rnDSGgugHkMbPT4x8KnMeneVd" as Address,
      runtime: "external",
      rules: { maxTxUsd: 10, approveAboveUsd: 5, destinations: ["self"], programs: ["jupiter"] },
      registeredAt: new Date().toISOString(),
    });
    const res = await req("/owner/agents/local-one/tokens", { token, body: {} });
    expect(res.status).toBe(409);
  });

  it("revokes an agent's tokens when it is removed", async () => {
    const token = await signedIn();
    const t = await mcpTemplate(token);
    await create(token, {
      template: "mcp-agent",
      cluster: "devnet",
      custody: "server",
      manifest: t.manifest,
    });
    const made = (await (
      await req("/owner/agents/mcp-agent/tokens", { token, body: {} })
    ).json()) as { id: string };
    ctx.rpc = () => fakeRpc() as never; // no delegations
    expect((await req("/owner/agents/mcp-agent", { token, method: "DELETE" })).status).toBe(200);
    const stored = (await ctx.store.tokens("mcp-agent")).find((x) => x.id === made.id);
    expect(stored?.revokedAt).toBeDefined();
  });
});
