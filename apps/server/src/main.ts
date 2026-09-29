// pnpm server: approvals API, Solana Actions (Blinks), Telegram bot, and housekeeping.
import { join } from "node:path";
import { syndromiHome } from "@syndromi/core";
import { listen } from "./app.js";
import { createContext } from "./context.js";
import { Store } from "./db.js";
import { startSweeper } from "./sweeper.js";
import { createTelegram } from "./telegram.js";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const token = env.SYNDROMI_SERVER_TOKEN;
if (!token) {
  console.error(
    "SYNDROMI_SERVER_TOKEN is not set. Add a random value to .env (e.g. `openssl rand -hex 24`);\n" +
      "the CLI uses the same variable to talk to the server.",
  );
  process.exit(1);
}

const store = new Store(env.SYNDROMI_DB ?? join(syndromiHome(env.SYNDROMI_HOME), "server.db"));
const ctx = createContext(store, {
  publicUrl: (env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
  token,
  env,
  draftTtlMs: 30 * 60 * 1000,
  topUpTtlMs: 24 * 60 * 60 * 1000,
});

await listen(ctx, port);
console.log(`syndromi server on http://localhost:${port} (public: ${ctx.config.publicUrl})`);
startSweeper(ctx);

if (env.TELEGRAM_BOT_TOKEN) {
  const telegram = await createTelegram(ctx, { token: env.TELEGRAM_BOT_TOKEN });
  await telegram.start();
  const link = telegram.linkUrl();
  console.log(
    link
      ? `Telegram: open ${link} and press Start to receive approvals.`
      : `Telegram: @${telegram.bot.botInfo.username} is linked to your chat.`,
  );
  process.once("SIGINT", () => void telegram.stop().then(() => process.exit(0)));
} else {
  console.log("Telegram: disabled (TELEGRAM_BOT_TOKEN not set).");
}
