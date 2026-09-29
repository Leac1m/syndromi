import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import { decryptKeypair, type EncryptedKeypair } from "@syndromi/core";
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

    const stored = ctx.store.hostedKey("scout-1") as EncryptedKeypair;
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
    ctx.store.upsertAgent({
      name: "bobs-agent",
      address: (await generateKeyPairSigner()).address,
      owner: bob.address as Address,
      cluster: "devnet",
      allowanceMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address,
      rules: { maxTxUsd: 25, approveAboveUsd: 10, destinations: ["self"], programs: ["jupiter"] },
      registeredAt: new Date().toISOString(),
    });
    ctx.store.addActivity("bobs-agent", {
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
    expect(() =>
      ctx.store.upsertAgent({
        ...(ctx.store.agent("bobs-agent") as NonNullable<ReturnType<Store["agent"]>>),
        owner: alice.address,
      }),
    ).toThrow(/different owner/);
  });
});
