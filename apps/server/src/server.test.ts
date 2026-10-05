import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getUtf8Encoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
} from "@solana/kit";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@solana/subscriptions";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { fakeRpc } from "@syndromi/tools/testing";
import type { Transformer } from "grammy";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createContext, type ServerContext } from "./context.js";
import { type AgentRecord, Store } from "./db.js";
import { describeMessage } from "./owner-tx.js";
import { createTelegram } from "./telegram.js";
import { createAgentToken } from "./tokens.js";

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
    dashboardOrigins: ["http://localhost:3000"],
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

describe("healthz", () => {
  it("answers when the store does, for any origin", async () => {
    const res = await app.request("/healthz", { headers: { origin: "https://elsewhere.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true, hosted: false, telegram: false });
  });

  it("is 503 when the store does not answer", async () => {
    ctx.store.setting = async () => {
      throw new Error("database is down");
    };
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
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

  it("refuses to re-register an agent under another address or owner", async () => {
    const register = (body: Record<string, unknown>) =>
      api("/api/agents", {
        name: "yield-scout",
        address: agent,
        owner: owner.address,
        cluster: "fork",
        allowanceMint: USDC,
        rules: { maxTxUsd: 25, approveAboveUsd: 10, destinations: ["self"], programs: ["jupiter"] },
        ...body,
      });
    expect((await register({})).status).toBe(200); // the same registration again is fine
    const moved = await register({ address: (await generateKeyPairSigner()).address });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({
      error: expect.stringMatching(/different address; remove it first/),
    });
    expect((await register({ owner: stranger.address })).status).toBe(409);
    expect((await ctx.store.agent("yield-scout"))?.address).toBe(agent);
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
    expect(await ctx.store.draft(id)).toMatchObject({
      status: "approved",
      approvalText: request.data,
    });

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
    expect((await ctx.store.draft(id))?.status).toBe("pending");

    await ctx.store.updateDraft(id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const card = (await (await action(`/actions/approve-draft/${id}`)).json()) as {
      disabled: boolean;
    };
    expect(card.disabled).toBe(true);
    expect((await ctx.store.draft(id))?.status).toBe("expired");
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

describe("owner transactions (/actions/tx/:id/submit)", () => {
  it("sends only the transaction that was issued, signed by its owner, once", async () => {
    const build = (data: number) =>
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(owner.address, m),
          (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: blockhash("11111111111111111111111111111111"),
                lastValidBlockHeight: 1n,
              },
              m,
            ),
          (m) =>
            appendTransactionMessageInstructions(
              [{ programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS, data: new Uint8Array([data]) }],
              m,
            ),
        ),
      );
    const issued = build(1);
    await ctx.store.saveOwnerTx({
      id: "x_test",
      owner: owner.address,
      cluster: "devnet",
      kind: "topup",
      ref: "t_x",
      description: describeMessage(issued.messageBytes),
      status: "issued",
      createdAt: new Date().toISOString(),
    });
    const submit = (account: string, tx = build(2)) =>
      action("/actions/tx/x_test/submit", {
        account,
        transaction: getBase64EncodedWireTransaction(tx),
      });

    const different = await submit(owner.address);
    expect(different.status).toBe(400);
    expect(await different.json()).toMatchObject({
      message: /not the transaction that was issued/,
    });
    expect((await submit(stranger.address, issued)).status).toBe(403);

    await ctx.store.saveOwnerTx({
      ...((await ctx.store.ownerTx("x_test")) as object),
      id: "x_test",
      status: "sent",
    });
    expect((await submit(owner.address, issued)).status).toBe(409);
  });
});

describe("describeMessage (what a submitted top-up may differ in)", () => {
  it("ignores compute-budget instructions a wallet adds, and nothing else", async () => {
    const payer = owner.address;
    const base = (ixs: Instruction[], feePayer: Address = payer) =>
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(feePayer, m),
          (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: blockhash("11111111111111111111111111111111"),
                lastValidBlockHeight: 1n,
              },
              m,
            ),
          (m) => appendTransactionMessageInstructions(ixs, m),
        ),
      ).messageBytes;
    const grant = (amount: number): Instruction => ({
      programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS,
      accounts: [{ address: payer, role: AccountRole.WRITABLE_SIGNER }],
      data: new Uint8Array([7, amount]),
    });
    const issued = describeMessage(
      base([getSetComputeUnitLimitInstruction({ units: 50_000 }), grant(5)]),
    );
    const phantom = describeMessage(
      base([
        getSetComputeUnitPriceInstruction({ microLamports: 99_999n }),
        getSetComputeUnitLimitInstruction({ units: 80_000 }),
        grant(5),
      ]),
    );
    expect(phantom).toBe(issued);
    expect(describeMessage(base([grant(50)]))).not.toBe(issued);
    expect(describeMessage(base([grant(5)], stranger.address))).not.toBe(issued);
    const extra: Instruction = {
      programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS,
      data: new Uint8Array([1]),
    };
    expect(describeMessage(base([grant(5), extra]))).not.toBe(issued);
  });
});

describe("approve page", () => {
  it("serves the Blink viewer for a draft, wired to its Action and owner", async () => {
    const { id } = await newDraft();
    const res = await app.request(`/approve/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`const ACTION = "/actions/approve-draft/${id}"`);
    expect(html).toContain(`OWNER = "${owner.address}"`);
    expect(html).toContain("solana:signMessage");
    // The inline script must parse (a lost backslash once turned a regex into a comment).
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
    const blink = await (
      await app.request("/blink?action=/actions/kill-switch?cluster=devnet")
    ).text();
    expect(
      () => new Function(blink.slice(blink.indexOf("<script>") + 8, blink.indexOf("</script>"))),
    ).not.toThrow();
    expect((await app.request("/approve/d_nope")).status).toBe(404);
  });
});

describe("Telegram", () => {
  type Call = { method: string; payload: Record<string, unknown> };

  /** A bot whose Telegram API calls are recorded instead of sent. */
  async function makeBot(webhookSecret?: string) {
    const calls: Call[] = [];
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
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const update = (chatId: number, text: string) => ({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1,
        date: 0,
        chat: { id: chatId, type: "private", first_name: "x" },
        from: { id: chatId, is_bot: false, first_name: "x" },
        text,
        entities: text.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length }]
          : [],
      },
    });
    const say = (chatId: number, text: string) =>
      telegram.bot.handleUpdate(update(chatId, text) as never);
    const press = (chatId: number, data: string) =>
      telegram.bot.handleUpdate({
        update_id: Math.floor(Math.random() * 1e9),
        callback_query: {
          id: "cb",
          from: { id: chatId, is_bot: false, first_name: "x" },
          chat_instance: "x",
          data,
          message: { message_id: 1, date: 0, chat: { id: chatId, type: "private" } },
        },
      } as never);
    /** Messages sent to one chat, oldest first. */
    const sentTo = (chatId: number) =>
      calls.filter(
        (c) => c.method === "sendMessage" && String(c.payload.chat_id) === String(chatId),
      );
    const answers = () => calls.filter((c) => c.method === "answerCallbackQuery");
    const link = async (chatId: number, who = owner.address) => {
      const { url } = await telegram.linkUrlFor(who);
      await say(chatId, `/start ${new URL(url).searchParams.get("start")}`);
    };
    return { telegram, calls, update, say, press, sentTo, answers, link };
  }
  const settle = () => new Promise((r) => setTimeout(r, 25));

  it("links a chat to the signed-in wallet with a one-time code, then pushes drafts to it", async () => {
    const b = await makeBot();
    const { url } = await b.telegram.linkUrlFor(owner.address);
    expect(url).toMatch(/^https:\/\/t\.me\/syndromi_bot\?start=\w{24}$/);
    const code = new URL(url).searchParams.get("start");

    await b.say(666, "/start wrongcode");
    expect(b.sentTo(666).at(-1)?.payload.text).toMatch(/expired or was already used/);
    await b.say(42, `/start ${code}`);
    expect(b.sentTo(42).at(-1)?.payload.text).toMatch(/^Linked to wallet /);
    await b.say(43, `/start ${code}`); // the same link, a second time, from another chat
    expect(b.sentTo(43).at(-1)?.payload.text).toMatch(/expired or was already used/);
    expect(await ctx.store.telegramChats(owner.address)).toEqual(["42"]);

    const { id } = await newDraft();
    await settle();
    const pushed = b.sentTo(42).at(-1);
    expect(pushed?.payload.chat_id).toBe("42");
    expect(String(pushed?.payload.text)).toMatch(/yield-scout<\/b> wants approval/);
    const buttons = JSON.stringify(pushed?.payload.reply_markup);
    expect(buttons).toContain(`"url":"http://localhost:8787/approve/${id}"`);
    expect(buttons).toContain(`reject:${id}`);
    expect(buttons).not.toContain("phantom.app"); // no phone button without an https URL

    // With a public https URL (the tunnel), a phone button opens the page inside Phantom.
    ctx.config.publicUrl = "https://demo.trycloudflare.com";
    const second = await newDraft();
    await settle();
    const page = `https://demo.trycloudflare.com/approve/${second.id}`;
    expect(JSON.stringify(b.sentTo(42).at(-1)?.payload.reply_markup)).toContain(
      `https://phantom.app/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent("https://demo.trycloudflare.com")}`,
    );

    ctx.bus.emit("activity", "yield-scout", {
      type: "blocked",
      summary: "transfer 5 USDC to AhLo…",
      reasons: ["token destination AhLo… not in allowlist"],
    });
    await settle();
    expect(String(b.sentTo(42).at(-1)?.payload.text)).toMatch(/BLOCKED<\/b>: yield-scout/);
  });

  it("sends each owner's alerts only to the chats linked to that owner", async () => {
    const b = await makeBot();
    const bob = (await generateKeyPairSigner()).address;
    expect(
      (
        await api("/api/agents", {
          name: "bobs-agent",
          address: (await generateKeyPairSigner()).address,
          owner: bob,
          cluster: "fork",
          allowanceMint: USDC,
          rules: {
            maxTxUsd: 25,
            approveAboveUsd: 10,
            destinations: ["self"],
            programs: ["jupiter"],
          },
        })
      ).status,
    ).toBe(200);
    await b.link(42, owner.address);
    await b.link(77, bob);

    const { id } = await newDraft();
    await settle();
    expect(b.sentTo(42)).toHaveLength(2); // the link confirmation and the draft
    expect(b.sentTo(77)).toHaveLength(1); // only its own link confirmation

    ctx.bus.emit("activity", "bobs-agent", { type: "blocked", summary: "x", reasons: ["y"] });
    ctx.bus.emit("activity", "kill-switch", {
      type: "kill",
      owner: bob,
      left: 0,
      cluster: "devnet",
    });
    await settle();
    expect(b.sentTo(42)).toHaveLength(2);
    expect(
      b
        .sentTo(77)
        .map((c) => String(c.payload.text))
        .join("\n"),
    ).toMatch(/BLOCKED[\s\S]*Kill switch/);

    // /pending lists only the chat's own items, and Reject only works for its own wallet.
    await b.say(77, "/pending");
    expect(String(b.sentTo(77).at(-1)?.payload.text)).toBe("Nothing pending.");
    await b.press(77, `reject:${id}`);
    expect(b.answers().at(-1)?.payload.text).toBe("Not allowed.");
    expect((await ctx.store.draft(id))?.status).toBe("pending");
    await b.say(42, "/pending");
    expect(String(b.sentTo(42).at(-1)?.payload.text)).toMatch(/yield-scout<\/b> wants approval/);
    await b.press(42, `reject:${id}`);
    expect(b.answers().at(-1)?.payload.text).toBe("Rejected.");
    expect((await ctx.store.draft(id))?.status).toBe("rejected");
  });

  /** A hosted agent of `owner` on devnet, never funded (the fake chain has no delegations). */
  const hostedAgent = (name: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
    name,
    address: agent,
    owner: owner.address,
    cluster: "devnet",
    allowanceMint: USDC,
    rules: { maxTxUsd: 10, approveAboveUsd: 5, destinations: ["self"], programs: ["orca"] },
    registeredAt: "2026-10-05T00:00:00.000Z",
    runtime: "hosted",
    allowance: { mint: "USDC", amount: 20, period: "weekly" },
    feeBudgetSol: 0.02,
    ...extra,
  });
  const edits = (b: { calls: Call[] }) => b.calls.filter((c) => c.method === "editMessageText");

  it("/status lists each agent with its budget, and Refresh edits the message in place", async () => {
    ctx.rpc = () => fakeRpc() as never;
    await ctx.store.upsertAgent(hostedAgent("night-owl"));
    const b = await makeBot();
    await b.link(42);

    await b.say(42, "/status");
    const status = b.sentTo(42).at(-1);
    const text = String(status?.payload.text);
    expect(text).toMatch(/<b>devnet<\/b> · wallet /);
    expect(text).toMatch(/🤖 <b>night-owl<\/b> · hosted\n {3}Not funded yet/);
    // The agent registered by a local runtime is listed too, on its own network.
    expect(text).toMatch(/<b>fork<\/b>[\s\S]*<b>yield-scout<\/b> · on your machine/);
    const buttons = JSON.stringify(status?.payload.reply_markup);
    expect(buttons).toContain("agent:night-owl");
    expect(buttons).toContain('"callback_data":"status"');

    await ctx.store.setAgentPaused("night-owl", true);
    await b.press(42, "status");
    expect(String(edits(b).at(-1)?.payload.text)).toMatch(/night-owl<\/b> · hosted · ⏸ paused/);
    expect(b.answers().at(-1)?.payload.text).toBe("Up to date.");

    // A chat that is not linked learns nothing.
    await b.say(99, "/status");
    expect(b.sentTo(99).at(-1)?.payload.text).toMatch(/To connect it/);
    await b.press(99, "status");
    expect(b.answers().at(-1)?.payload.text).toBe("Not allowed.");
    await b.press(99, "agent:night-owl");
    expect(b.answers().at(-1)?.payload.text).toBe("Not allowed.");
    expect(b.sentTo(99)).toHaveLength(1);
  });

  it("pauses an agent from its card, once, and never offers to resume it", async () => {
    ctx.rpc = () => fakeRpc() as never;
    await ctx.store.upsertAgent(hostedAgent("night-owl"));
    const b = await makeBot();
    await b.link(42);

    await b.press(42, "agent:night-owl");
    const card = b.sentTo(42).at(-1);
    expect(String(card?.payload.text)).toMatch(
      /at most \$10 a transaction, your signature above \$5/,
    );
    expect(JSON.stringify(card?.payload.reply_markup)).toContain("pause:night-owl");

    // Only a chat linked to the owner's wallet may pause.
    await b.press(99, "pause:night-owl");
    expect(b.answers().at(-1)?.payload.text).toBe("Not allowed.");
    expect((await ctx.store.agent("night-owl"))?.paused).toBeUndefined();

    await b.press(42, "pause:night-owl");
    expect(b.answers().at(-1)?.payload.text).toBe("Paused. Resume it in the dashboard.");
    expect((await ctx.store.agent("night-owl"))?.paused).toBe(true);
    // The card now points at the dashboard to resume; Telegram has no button that loosens.
    const after = JSON.stringify(edits(b).at(-1)?.payload.reply_markup);
    expect(after).not.toContain("pause:night-owl");
    expect(after).toContain("http://127.0.0.1:3000/app/agents/night-owl");
    expect(JSON.stringify(b.calls)).not.toMatch(/"callback_data":"(resume|unpause)/);

    // A second tap (a slow network) changes nothing and says so.
    await b.press(42, "pause:night-owl");
    expect(b.answers().at(-1)?.payload.text).toBe("Already paused.");
    const feed = (await ctx.store.activity({ agentNames: ["night-owl"], limit: 20 })).filter(
      (e) => e.kind === "pause",
    );
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ status: "paused", summary: expect.stringMatching(/Telegram/) });

    // An agent that holds its own key cannot be paused by the server.
    await b.press(42, "pause:yield-scout");
    expect(b.answers().at(-1)?.payload.text).toMatch(/holds its own key/);
    expect((await ctx.store.agent("yield-scout"))?.paused).toBeUndefined();
  });

  it("cuts off a server-held agent's AI by revoking its access tokens", async () => {
    ctx.rpc = () => fakeRpc() as never;
    const remote = hostedAgent("my-claude", { runtime: "external", custody: "server" });
    await ctx.store.upsertAgent(remote);
    await createAgentToken(ctx, remote, { label: "laptop" });
    await createAgentToken(ctx, remote, { label: "phone" });
    const b = await makeBot();
    await b.link(42);

    await b.press(42, "agent:my-claude");
    const buttons = JSON.stringify(b.sentTo(42).at(-1)?.payload.reply_markup);
    expect(buttons).toContain("cut:my-claude");
    expect(String(b.sentTo(42).at(-1)?.payload.text)).toMatch(/my-claude<\/b> · your AI/);

    await b.press(99, "cut:my-claude");
    expect(b.answers().at(-1)?.payload.text).toBe("Not allowed.");
    expect((await ctx.store.tokens("my-claude")).every((t) => !t.revokedAt)).toBe(true);

    await b.press(42, "cut:my-claude");
    expect(b.answers().at(-1)?.payload.text).toBe("Revoked 2 access tokens. Its AI is cut off.");
    expect((await ctx.store.tokens("my-claude")).every((t) => t.revokedAt)).toBe(true);
    await b.press(42, "cut:my-claude");
    expect(b.answers().at(-1)?.payload.text).toBe("It has no live access tokens.");
  });

  it("lets one chat hold several wallets, and /unlink stops the messages", async () => {
    const b = await makeBot();
    await b.link(42, owner.address);
    await b.link(42, stranger.address);
    expect((await ctx.store.telegramOwners("42")).sort()).toEqual(
      [owner.address, stranger.address].sort(),
    );

    await b.say(42, "/unlink");
    expect(String(b.sentTo(42).at(-1)?.payload.text)).toMatch(/^Unlinked/);
    const before = b.sentTo(42).length;
    await newDraft();
    await settle();
    expect(b.sentTo(42)).toHaveLength(before);
  });

  it("points strangers at the dashboard instead of linking them", async () => {
    const b = await makeBot();
    await b.say(9, "/start");
    expect(String(b.sentTo(9).at(-1)?.payload.text)).toContain(
      'http://localhost:3000/app, sign in with your wallet, and press "Connect Telegram"',
    );
    await b.say(9, "/pending");
    await b.say(9, "/kill");
    await b.say(9, "hello?");
    expect(b.sentTo(9)).toHaveLength(4);
    expect(b.sentTo(9).every((c) => /Connect Telegram/.test(String(c.payload.text)))).toBe(true);
    await b.press(9, "reject:d_whatever");
    expect(b.answers().at(-1)?.payload.text).toBe("Not allowed.");
  });

  it("takes updates by webhook only with the secret header", async () => {
    const b = await makeBot("s3cret-value");
    ctx.telegram = b.telegram;
    const post = (headers: Record<string, string>) =>
      app.request("/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(b.update(5, "/start")),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
    expect(b.sentTo(5)).toHaveLength(0);
    expect((await post({ "x-telegram-bot-api-secret-token": "s3cret-value" })).status).toBe(200);
    await settle();
    expect(String(b.sentTo(5).at(-1)?.payload.text)).toMatch(/Connect Telegram/);

    // Without a webhook configured the route does not exist.
    ctx.telegram = (await makeBot()).telegram;
    expect((await post({ "x-telegram-bot-api-secret-token": "s3cret-value" })).status).toBe(404);
  });

  it("moves a pre-multi-owner chat link to the server's agent owners", async () => {
    await ctx.store.setSetting("telegram_chat_id", "42");
    await ctx.store.setSetting("telegram_link_code", "oldcode");
    await makeBot();
    expect(await ctx.store.telegramOwners("42")).toEqual([owner.address]);
    expect(await ctx.store.setting("telegram_chat_id")).toBeUndefined();
    expect(await ctx.store.setting("telegram_link_code")).toBeUndefined();
  });
});
