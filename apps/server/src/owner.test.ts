import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import { decryptKeypair, type EncryptedKeypair } from "@syndromi/core";
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
      allowanceMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address,
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
