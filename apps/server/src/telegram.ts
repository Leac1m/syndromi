// Telegram: the owner's approval inbox. Long polling (no webhook or public URL needed).
// Linking: the server prints https://t.me/<bot>?start=<one-time code>; /start <code> binds that
// chat, and every other chat is ignored. Approve buttons open the Blink on dial.to, so approving
// always means signing in the wallet; Reject needs no signature.
import { explorerTx, tokenByMint, toUiAmount } from "@syndromi/core";
import { Bot, InlineKeyboard, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { blinkUrl } from "./actions/spec.js";
import type { ServerContext } from "./context.js";
import type { DraftRecord, TopUpRecord } from "./db.js";

const CHAT = "telegram_chat_id";
const CODE = "telegram_link_code";

export type Telegram = {
  bot: Bot;
  /** Deep link that binds the owner's chat, or undefined once bound. */
  linkUrl(): string | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export async function createTelegram(
  ctx: ServerContext,
  opts: { token: string; botInfo?: UserFromGetMe; transformer?: Transformer },
): Promise<Telegram> {
  const { store, bus, config } = ctx;
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  if (opts.transformer) bot.api.config.use(opts.transformer);
  if (!opts.botInfo) await bot.init();

  if (!store.setting(CHAT) && !store.setting(CODE)) {
    store.setSetting(CODE, crypto.randomUUID().replaceAll("-", "").slice(0, 16));
  }
  const chatId = () => store.setting(CHAT);
  const isOwner = (id: number | undefined) => id !== undefined && String(id) === chatId();

  bot.command("start", async (c) => {
    if (isOwner(c.chat.id)) return c.reply("Already linked. Approvals will arrive here.");
    const code = store.setting(CODE);
    if (!code || c.match.trim() !== code) return c.reply("This syndromi bot is private.");
    store.setSetting(CHAT, String(c.chat.id));
    store.db.prepare("delete from settings where key = ?").run(CODE);
    return c.reply(
      "Linked. You'll get approval requests, top-up requests, and BLOCKED alerts here. " +
        "Approving always means signing in your wallet.",
    );
  });

  bot.command("pending", async (c) => {
    if (!isOwner(c.chat.id)) return;
    const drafts = store.drafts({ status: "pending" });
    const topups = store.topUps({ status: "pending" });
    if (!drafts.length && !topups.length) return c.reply("Nothing pending.");
    for (const d of drafts) await send(draftMessage(d), draftKeyboard(d));
    for (const t of topups) await send(topUpMessage(t), topUpKeyboard(t));
  });

  bot.callbackQuery(/^reject:(d_\w+|t_\w+)$/, async (c) => {
    if (!isOwner(c.chat?.id)) return c.answerCallbackQuery({ text: "Not allowed." });
    const id = c.match[1] ?? "";
    const record = id.startsWith("d_") ? store.draft(id) : store.topUp(id);
    if (!record || record.status !== "pending") {
      return c.answerCallbackQuery({ text: `Already ${record?.status ?? "gone"}.` });
    }
    if (id.startsWith("d_")) bus.emit("draft", store.updateDraft(id, { status: "rejected" }));
    else bus.emit("topup", store.updateTopUp(id, { status: "rejected" }));
    await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return c.answerCallbackQuery({ text: "Rejected." });
  });

  async function send(html: string, keyboard?: InlineKeyboard) {
    const chat = chatId();
    if (!chat) return;
    await bot.api
      .sendMessage(chat, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      .catch((e) => console.error("telegram:", (e as Error).message));
  }

  const draftKeyboard = (d: DraftRecord) =>
    new InlineKeyboard()
      .url("Approve in wallet", blinkUrl(config.publicUrl, `/actions/approve-draft/${d.id}`))
      .text("Reject", `reject:${d.id}`);
  const topUpKeyboard = (t: TopUpRecord) =>
    new InlineKeyboard()
      .url("Approve in wallet", blinkUrl(config.publicUrl, `/actions/approve-topup/${t.id}`))
      .text("Reject", `reject:${t.id}`);

  function draftMessage(d: DraftRecord): string {
    const agent = store.agent(d.agentName);
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
    if (d.status === "pending") void send(draftMessage(d), draftKeyboard(d));
    else if (messages[d.status]) void send(messages[d.status] as string);
  });

  bus.on("topup", (t) => {
    const messages: Partial<Record<TopUpRecord["status"], string>> = {
      approved: `✅ Top-up approved: <b>${esc(t.agentName)}</b> can pull ${amount(t)}.`,
      pulled: `✅ <b>${esc(t.agentName)}</b> pulled its ${amount(t)} top-up.`,
      failed: `❌ Top-up pull failed: ${esc(t.resultError ?? "")}`,
      expired: `⌛ Top-up request expired: ${amount(t)} for ${esc(t.agentName)}`,
      rejected: `🚫 Top-up rejected: ${amount(t)} for ${esc(t.agentName)}`,
    };
    if (t.status === "pending") void send(topUpMessage(t), topUpKeyboard(t));
    else if (messages[t.status]) void send(messages[t.status] as string);
  });

  bus.on("activity", (agentName, e) => {
    if (e.type !== "blocked") return;
    const reasons = (e.reasons as string[] | undefined) ?? [];
    void send(
      `🛑 <b>BLOCKED</b>: ${esc(agentName)} tried to ${esc(String(e.summary ?? e.tool))}\n` +
        reasons.map((r) => `• ${esc(r)}`).join("\n"),
    );
  });

  return {
    bot,
    linkUrl: () => {
      const code = store.setting(CODE);
      return code ? `https://t.me/${bot.botInfo.username}?start=${code}` : undefined;
    },
    start: async () => {
      void bot.start({ drop_pending_updates: true, onStart: () => undefined });
    },
    stop: async () => {
      await bot.stop();
    },
  };
}

function amount(t: TopUpRecord) {
  const token = tokenByMint(t.mint);
  return `${toUiAmount(t.amount, token?.decimals ?? 6)} ${token?.symbol ?? "tokens"}`;
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
