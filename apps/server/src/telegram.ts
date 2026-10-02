// Telegram: each owner's approval inbox. A signed-in owner presses "Connect Telegram" in the
// dashboard, which issues a one-time link (https://t.me/<bot>?start=<code>); /start <code> binds
// that chat to the wallet. A chat may hold several wallets, and every alert goes only to the chats
// linked to the agent's owner. Approve buttons open the Blink (our viewer at /approve/:id, or
// dial.to), so approving always means signing in the wallet; Reject needs no signature and works
// only for items of a wallet linked to the chat. Telegram rejects "localhost" in button URLs;
// 127.0.0.1 works.
// Updates arrive by long polling, or by webhook when TELEGRAM_WEBHOOK_SECRET is set (a hosted
// server that sleeps is woken by Telegram's request).
import { explorerTx, tokenByMint, toUiAmount } from "@syndromi/core";
import { Bot, InlineKeyboard, type Transformer, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Context as HonoContext } from "hono";
import { blinkUrl } from "./actions/spec.js";
import type { ServerContext } from "./context.js";
import { type DraftRecord, StatusChanged, TELEGRAM_CODE_TTL_MS, type TopUpRecord } from "./db.js";

/** The pre-multi-owner single-chat settings, migrated on startup. */
const LEGACY_CHAT = "telegram_chat_id";
const LEGACY_CODE = "telegram_link_code";

export const WEBHOOK_PATH = "/telegram/webhook";

export type Telegram = {
  bot: Bot;
  /** A t.me link that binds the chat opening it to `owner`'s wallet (works once, for 10 minutes). */
  linkUrlFor(owner: string): Promise<{ url: string; expiresAt: string }>;
  /** Set when updates arrive by webhook: mount it at WEBHOOK_PATH. */
  webhook?: (c: HonoContext) => Promise<Response>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export async function createTelegram(
  ctx: ServerContext,
  opts: {
    token: string;
    botInfo?: UserFromGetMe;
    transformer?: Transformer;
    /** Receive updates by webhook (needs an https PUBLIC_URL) instead of long polling. */
    webhookSecret?: string;
  },
): Promise<Telegram> {
  const { store, bus, config } = ctx;
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  if (opts.transformer) bot.api.config.use(opts.transformer);
  if (!opts.botInfo) await bot.init();

  await migrateLegacyLink();

  /** The dashboard testers are sent to, from the origins the server already trusts. */
  const dashboardUrl = () => {
    const origin =
      config.dashboardOrigins.find((o) => o.startsWith("https://")) ?? config.dashboardOrigins[0];
    return origin ? `${origin.replace(/\/+$/, "")}/app` : undefined;
  };
  const welcome = (note = "") => {
    const where = dashboardUrl();
    return (
      `${note ? `${note}\n\n` : ""}syndromi gives AI agents on Solana a budget you control. ` +
      `This bot sends you their approval requests and alerts.\n\n` +
      (where
        ? `To connect it: open ${where}, sign in with your wallet, and press "Connect Telegram".`
        : `To connect it, sign in to the syndromi dashboard and press "Connect Telegram".`)
    );
  };

  bot.command("start", async (c) => {
    const chat = String(c.chat.id);
    const code = c.match.trim();
    if (code) {
      const owner = await store.consumeTelegramCode(code);
      if (!owner) return c.reply(welcome("That link expired or was already used."));
      await store.linkTelegram(chat, owner);
      return c.reply(
        `Linked to wallet ${short(owner)}. You'll get approval requests, top-up requests, and ` +
          `BLOCKED alerts for its agents here. Approving always means signing in your wallet.\n\n` +
          `/pending lists what waits for you, /kill revokes every allowance, /unlink stops these messages.`,
      );
    }
    const owners = await store.telegramOwners(chat);
    if (!owners.length) return c.reply(welcome());
    return c.reply(`Already linked (${owners.map(short).join(", ")}). Approvals will arrive here.`);
  });

  bot.command("pending", async (c) => {
    const owners = await store.telegramOwners(String(c.chat.id));
    if (!owners.length) return c.reply(welcome());
    const [drafts, topups] = await Promise.all([
      store.drafts({ status: "pending" }),
      store.topUps({ status: "pending" }),
    ]);
    const mine = drafts.filter((d) => owners.includes(d.owner));
    const mineTopUps = topups.filter((t) => owners.includes(t.owner));
    if (!mine.length && !mineTopUps.length) return c.reply("Nothing pending.");
    const chat = String(c.chat.id);
    for (const d of mine) await sendTo(chat, await draftMessage(d), draftKeyboard(d));
    for (const t of mineTopUps) await sendTo(chat, topUpMessage(t), topUpKeyboard(t));
  });

  bot.command("kill", async (c) => {
    if (!(await store.telegramOwners(String(c.chat.id))).length) return c.reply(welcome());
    const link = (cluster: string) =>
      `${config.publicUrl}/blink?action=${encodeURIComponent(`/actions/kill-switch?cluster=${cluster}`)}`;
    const keyboard = new InlineKeyboard()
      .url("Revoke all (devnet)", link("devnet"))
      .url("Revoke all (mainnet)", link("mainnet"));
    const phoneDevnet = phoneUrl(link("devnet"));
    const phoneMainnet = phoneUrl(link("mainnet"));
    if (phoneDevnet && phoneMainnet) {
      keyboard.row().url("Phone: devnet", phoneDevnet).url("Phone: mainnet", phoneMainnet);
    }
    return c.reply(
      "🛑 Kill switch: revoke every allowance and top-up. Sign in your wallet to confirm.",
      { reply_markup: keyboard },
    );
  });

  bot.command("unlink", async (c) => {
    const removed = await store.unlinkTelegramChat(String(c.chat.id));
    return c.reply(
      removed
        ? "Unlinked. You won't get messages here anymore; connect again from the dashboard any time."
        : welcome(),
    );
  });

  bot.callbackQuery(/^reject:(d_\w+|t_\w+)$/, async (c) => {
    const owners = await store.telegramOwners(String(c.chat?.id ?? ""));
    const id = c.match[1] ?? "";
    const record = id.startsWith("d_") ? await store.draft(id) : await store.topUp(id);
    // Only the wallets linked to this chat may reject; anyone else is told nothing about the item.
    if (!record || !owners.includes(record.owner)) {
      return c.answerCallbackQuery({ text: "Not allowed." });
    }
    if (record.status !== "pending") {
      return c.answerCallbackQuery({ text: `Already ${record.status}.` });
    }
    try {
      if (id.startsWith("d_")) {
        bus.emit("draft", await store.updateDraft(id, { status: "rejected" }, ["pending"]));
      } else {
        bus.emit("topup", await store.updateTopUp(id, { status: "rejected" }, ["pending"]));
      }
    } catch (e) {
      if (!(e instanceof StatusChanged)) throw e;
      return c.answerCallbackQuery({ text: `Already ${e.status}.` });
    }
    await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return c.answerCallbackQuery({ text: "Rejected." });
  });

  // Anything else, from a chat that is not linked: point it at the dashboard.
  bot.on("message", async (c) => {
    if (!(await store.telegramOwners(String(c.chat.id))).length) return c.reply(welcome());
    return c.reply("Commands: /pending, /kill, /unlink.");
  });

  async function sendTo(chat: string, html: string, keyboard?: InlineKeyboard) {
    await bot.api
      .sendMessage(chat, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      .catch((e) => console.error("telegram:", (e as Error).message));
  }

  /** Send to every chat linked to `owner`. A failure for one chat never stops the others. */
  async function notify(owner: string, html: string | Promise<string>, keyboard?: InlineKeyboard) {
    try {
      const [text, chats] = await Promise.all([html, store.telegramChats(owner)]);
      for (const chat of chats) await sendTo(chat, text, keyboard);
    } catch (e) {
      console.error("telegram:", (e as Error).message);
    }
  }

  // Our own Blink viewer by default; BLINK_VIEWER=dialto uses dial.to (when it is up).
  const approveUrl = (id: string) =>
    config.env.BLINK_VIEWER === "dialto"
      ? blinkUrl(
          config.publicUrl,
          `/actions/approve-${id.startsWith("d_") ? "draft" : "topup"}/${id}`,
        )
      : `${config.publicUrl}/approve/${id}`;
  // On a phone there is no wallet extension: Phantom's browse deep link opens the page inside
  // Phantom's in-app browser. Only offered when the server has a public https URL (the tunnel).
  const phoneUrl = (page: string) =>
    config.publicUrl.startsWith("https://")
      ? `https://phantom.app/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(config.publicUrl)}`
      : undefined;
  const approvalKeyboard = (id: string) => {
    const keyboard = new InlineKeyboard().url("Approve in wallet", approveUrl(id));
    const phone = phoneUrl(`${config.publicUrl}/approve/${id}`);
    if (phone) keyboard.url("Open in Phantom (phone)", phone);
    return keyboard.row().text("Reject", `reject:${id}`);
  };
  const draftKeyboard = (d: DraftRecord) => approvalKeyboard(d.id);
  const topUpKeyboard = (t: TopUpRecord) => approvalKeyboard(t.id);

  async function draftMessage(d: DraftRecord): Promise<string> {
    const agent = await store.agent(d.agentName).catch(() => undefined);
    const threshold = agent
      ? `, above your $${agent.rules.approveAboveUsd} approval threshold`
      : "";
    const minutes = Math.round((Date.parse(d.expiresAt) - Date.now()) / 60_000);
    return (
      `⏸ <b>${esc(d.agentName)}</b> wants approval\n${esc(d.summary)}\n` +
      `$${d.usd.toFixed(2)}${threshold}. Expires in ${minutes} min.`
    );
  }
  function topUpMessage(t: TopUpRecord): string {
    return `💸 <b>${esc(t.agentName)}</b> asks for a top-up of ${amount(t)}\nReason: ${esc(t.reason)}`;
  }

  bus.on("draft", (d) => {
    const link = (sig?: string) =>
      sig ? `\n<a href="${explorerTx(sig, d.cluster)}">View transaction</a>` : "";
    const messages: Partial<Record<DraftRecord["status"], string>> = {
      approved: `✅ Approved. <b>${esc(d.agentName)}</b> will execute: ${esc(d.summary)}`,
      executed: `✅ Executed: ${esc(d.summary)}${link(d.resultSignature)}`,
      stale: `⚠️ Not executed: the price moved more than 10% since you approved ${esc(d.summary)}.`,
      failed: `❌ Failed: ${esc(d.summary)}\n${esc(d.resultError ?? "")}`,
      expired: `⌛ Expired without approval: ${esc(d.summary)}`,
      rejected: `🚫 Rejected: ${esc(d.summary)}`,
    };
    if (d.status === "pending") void notify(d.owner, draftMessage(d), draftKeyboard(d));
    else if (messages[d.status]) void notify(d.owner, messages[d.status] as string);
  });

  bus.on("topup", (t) => {
    const messages: Partial<Record<TopUpRecord["status"], string>> = {
      approved: `✅ Top-up approved: <b>${esc(t.agentName)}</b> can pull ${amount(t)}.`,
      pulled: `✅ <b>${esc(t.agentName)}</b> pulled its ${amount(t)} top-up.`,
      failed: `❌ Top-up pull failed: ${esc(t.resultError ?? "")}`,
      expired: `⌛ Top-up request expired: ${amount(t)} for ${esc(t.agentName)}`,
      rejected: `🚫 Top-up rejected: ${amount(t)} for ${esc(t.agentName)}`,
    };
    if (t.status === "pending") void notify(t.owner, topUpMessage(t), topUpKeyboard(t));
    else if (messages[t.status]) void notify(t.owner, messages[t.status] as string);
  });

  bus.on("activity", (agentName, e) => {
    if (e.type !== "kill" && e.type !== "blocked") return;
    void (async () => {
      // The kill switch names its owner; other events belong to the agent's owner.
      const owner =
        typeof e.owner === "string"
          ? e.owner
          : (await store.agent(agentName).catch(() => undefined))?.owner;
      if (!owner) return;
      if (e.type === "kill") {
        await notify(
          owner,
          e.left
            ? `🛑 Kill switch: some delegations revoked on ${esc(String(e.cluster))}; ${e.left} left.`
            : `🛑 Kill switch: every delegation on ${esc(String(e.cluster))} is revoked. No agent can pull from your bag.`,
        );
        return;
      }
      const reasons = (e.reasons as string[] | undefined) ?? [];
      await notify(
        owner,
        `🛑 <b>BLOCKED</b>: ${esc(agentName)} tried to ${esc(String(e.summary ?? e.tool))}\n` +
          reasons.map((r) => `• ${esc(r)}`).join("\n"),
      );
    })();
  });

  /** Chats linked before wallets were tracked belong to the server's agent owners. */
  async function migrateLegacyLink() {
    const chat = await store.setting(LEGACY_CHAT);
    if (!chat) {
      await store.deleteSetting(LEGACY_CODE);
      return;
    }
    for (const owner of new Set((await store.agents()).map((a) => a.owner))) {
      await store.linkTelegram(chat, owner);
    }
    await store.deleteSetting(LEGACY_CHAT);
    await store.deleteSetting(LEGACY_CODE);
  }

  const secretToken = opts.webhookSecret;
  const webhook = secretToken
    ? (webhookCallback(bot, "hono", { secretToken }) as (c: HonoContext) => Promise<Response>)
    : undefined;

  return {
    bot,
    linkUrlFor: async (owner) => {
      const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
      await store.issueTelegramCode(code, owner);
      return {
        url: `https://t.me/${bot.botInfo.username}?start=${code}`,
        expiresAt: new Date(Date.now() + TELEGRAM_CODE_TTL_MS).toISOString(),
      };
    },
    ...(webhook ? { webhook } : {}),
    start: async () => {
      if (secretToken) {
        if (!config.publicUrl.startsWith("https://")) {
          throw new Error("Telegram webhooks need an https PUBLIC_URL");
        }
        await bot.api.setWebhook(`${config.publicUrl}${WEBHOOK_PATH}`, {
          secret_token: secretToken,
          allowed_updates: ["message", "callback_query"],
        });
        return;
      }
      void bot.start({ drop_pending_updates: true, onStart: () => undefined });
    },
    stop: async () => {
      if (!secretToken) await bot.stop();
    },
  };
}

function amount(t: TopUpRecord) {
  const token = tokenByMint(t.mint);
  return `${toUiAmount(t.amount, token?.decimals ?? 6)} ${token?.symbol ?? "tokens"}`;
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
