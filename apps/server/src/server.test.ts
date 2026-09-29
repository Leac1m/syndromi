import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import type { Transformer } from "grammy";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createContext, type ServerContext } from "./context.js";
import { Store } from "./db.js";
import { createTelegram } from "./telegram.js";

const TOKEN = "test-token";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
let owner: KeyPairSigner;
let stranger: KeyPairSigner;
let agent: Address;
let ctx: ServerContext;
let app: ReturnType<typeof createApp>;

const api = (path: string, body?: unknown, token = TOKEN) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const action = (path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const signText = async (signer: KeyPairSigner, text: string) =>
  getBase58Decoder().decode(
    await signBytes(signer.keyPair.privateKey, getUtf8Encoder().encode(text)),
  );

async function newDraft(usd = 15) {
  const res = await api("/api/drafts", {
    agentName: "yield-scout",
    agent,
    tool: "jupiter-swap",
    input: { from: "USDC", to: "JitoSOL", amount: usd },
    intent: { kind: "swap", inputMint: USDC, inputAmount: String(usd * 1e6) },
    decision: { verdict: "needs_approval", reasons: ["above threshold"], usd },
    summary: `swap ${usd} USDC → ~0.0966 JitoSOL`,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

beforeEach(async () => {
  owner = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  agent = (await generateKeyPairSigner()).address;
  ctx = createContext(new Store(":memory:"), {
    publicUrl: "http://localhost:8787",
    token: TOKEN,
    env: {},
    draftTtlMs: 30 * 60 * 1000,
    topUpTtlMs: 24 * 60 * 60 * 1000,
  });
  app = createApp(ctx);
  await api("/api/agents", {
    name: "yield-scout",
    address: agent,
    owner: owner.address,
    cluster: "fork",
    allowanceMint: USDC,
    rules: { maxTxUsd: 25, approveAboveUsd: 10, destinations: ["self"], programs: ["jupiter"] },
  });
});

describe("Actions spec plumbing", () => {
  it("serves actions.json, CORS preflight, and the version/chain headers", async () => {
    const manifest = await action("/actions.json");
    expect(manifest.headers.get("access-control-allow-origin")).toBe("*");
    expect(await manifest.json()).toEqual({
      rules: [{ pathPattern: "/actions/**", apiPath: "/actions/**" }],
    });
    const preflight = await app.request("/actions/approve-draft/x", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    const { id } = await newDraft();
    const card = await action(`/actions/approve-draft/${id}`);
    expect(card.headers.get("x-action-version")).toBe("2.4");
    expect(card.headers.get("x-blockchain-ids")).toMatch(/^solana:/);
  });

  it("guards the runtime API with the bearer token", async () => {
    expect((await api("/api/agents/yield-scout/approvals", undefined, "wrong")).status).toBe(401);
  });
});

describe("approving a draft by signing a message", () => {
  it("runs the sign-message flow end to end for the owner", async () => {
    const { id } = await newDraft();
    const card = (await (await action(`/actions/approve-draft/${id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(card).toMatchObject({
      type: "action",
      disabled: false,
      title: "yield-scout wants approval",
    });
    expect(String(card.description)).toMatch(/above your \$10 approval threshold/);

    const post = await action(`/actions/approve-draft/${id}`, { account: owner.address });
    const request = (await post.json()) as {
      type: string;
      data: string;
      state: string;
      links: { next: { href: string } };
    };
    expect(request.type).toBe("message");
    expect(request.data).toMatch(new RegExp(`Approve draft ${id} for agent yield-scout`));
    expect(request.data).toMatch(/at most \$15\.00/);

    const verified = await action(request.links.next.href, {
      account: owner.address,
      signature: await signText(owner, request.data),
      data: request.data,
      state: request.state,
    });
    expect(await verified.json()).toMatchObject({ type: "completed", title: "Approved" });
    expect(ctx.store.draft(id)).toMatchObject({ status: "approved", approvalText: request.data });

    const approvals = (await (await api("/api/agents/yield-scout/approvals")).json()) as {
      drafts: { id: string; intent: { inputAmount: string } }[];
    };
    expect(approvals.drafts.map((d) => d.id)).toEqual([id]);
    expect(approvals.drafts[0]?.intent.inputAmount).toBe("15000000");
  });

  it("refuses non-owners, forged signatures, replays, and expired drafts", async () => {
    const { id } = await newDraft();
    const asStranger = await action(`/actions/approve-draft/${id}`, { account: stranger.address });
    expect(asStranger.status).toBe(403);

    const request = (await (
      await action(`/actions/approve-draft/${id}`, { account: owner.address })
    ).json()) as {
      data: string;
      state: string;
    };
    const forged = await action(`/actions/approve-draft/${id}/verify`, {
      account: owner.address,
      signature: await signText(stranger, request.data),
      data: request.data,
      state: request.state,
    });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ message: /signature does not match the owner/ });
    // The nonce was consumed by the failed attempt: replaying it (even correctly signed) fails.
    const replay = await action(`/actions/approve-draft/${id}/verify`, {
      account: owner.address,
      signature: await signText(owner, request.data),
      data: request.data,
      state: request.state,
    });
    expect(await replay.json()).toMatchObject({ message: /already used/ });
    expect(ctx.store.draft(id)?.status).toBe("pending");

    ctx.store.updateDraft(id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const card = (await (await action(`/actions/approve-draft/${id}`)).json()) as {
      disabled: boolean;
    };
    expect(card.disabled).toBe(true);
    expect(ctx.store.draft(id)?.status).toBe("expired");
    expect((await action(`/actions/approve-draft/${id}`, { account: owner.address })).status).toBe(
      409,
    );
  });
});

describe("top-up requests", () => {
  it("shows the card and only lets the owner request the transaction", async () => {
    const res = await api("/api/topups", {
      agentName: "yield-scout",
      mint: USDC,
      amount: "10000000",
      reason: "allowance used up",
    });
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^t_/);
    const card = (await (await action(`/actions/approve-topup/${id}`)).json()) as { label: string };
    expect(card.label).toBe("Approve 10 USDC");
    expect(
      (await action(`/actions/approve-topup/${id}`, { account: stranger.address })).status,
    ).toBe(403);
  });
});

describe("Telegram", () => {
  it("binds the owner's chat with the one-time code, then pushes drafts with a Blink button", async () => {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const transformer: Transformer = async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return {
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
      } as never;
    };
    const telegram = await createTelegram(ctx, {
      token: "123:test",
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "syndromi",
        username: "syndromi_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      } as never,
      transformer,
    });
    const link = telegram.linkUrl();
    expect(link).toMatch(/^https:\/\/t\.me\/syndromi_bot\?start=\w{16}$/);
    const code = new URL(String(link)).searchParams.get("start");
    const start = (chatId: number, text: string) =>
      telegram.bot.handleUpdate({
        update_id: chatId,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: chatId, type: "private", first_name: "x" },
          from: { id: chatId, is_bot: false, first_name: "x" },
          text,
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      } as never);

    await start(666, "/start wrongcode");
    expect(calls.at(-1)?.payload.text).toMatch(/private/);
    await start(42, `/start ${code}`);
    expect(calls.at(-1)?.payload.text).toMatch(/^Linked/);
    expect(telegram.linkUrl()).toBeUndefined();

    const { id } = await newDraft();
    await new Promise((r) => setTimeout(r, 0));
    const pushed = calls.at(-1);
    expect(pushed?.method).toBe("sendMessage");
    expect(pushed?.payload.chat_id).toBe("42");
    expect(String(pushed?.payload.text)).toMatch(/yield-scout<\/b> wants approval/);
    const buttons = JSON.stringify(pushed?.payload.reply_markup);
    expect(buttons).toContain(
      `https://dial.to/?action=${encodeURIComponent(`solana-action:http://localhost:8787/actions/approve-draft/${id}`)}`,
    );
    expect(buttons).toContain(`reject:${id}`);

    ctx.bus.emit("activity", "dca-agent", {
      type: "blocked",
      summary: "transfer 5 USDC to AhLo…",
      reasons: ["token destination AhLo… not in allowlist"],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(String(calls.at(-1)?.payload.text)).toMatch(/BLOCKED<\/b>: dca-agent/);
  });
});
