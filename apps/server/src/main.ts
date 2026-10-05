// pnpm server: approvals API, Solana Actions (Blinks), Telegram bot, and housekeeping.
import { join } from "node:path";
import { syndromiHome } from "@syndromi/core";
import { listen } from "./app.js";
import { faucetAmount } from "./beta/faucet.js";
import { loadTreasury, TREASURY_LOW_SOL, treasurySol } from "./beta/treasury.js";
import { createContext } from "./context.js";
import { Store } from "./db.js";
import { HostedRuntime } from "./hosted.js";
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

// DATABASE_URL (Postgres) when hosted, so data survives restarts; a local SQLite file otherwise.
const target =
  env.DATABASE_URL || env.SYNDROMI_DB || join(syndromiHome(env.SYNDROMI_HOME), "server.db");
const store = new Store(target);
try {
  await store.ready;
} catch (e) {
  console.error(`Could not open the database (${describeTarget(target)}): ${(e as Error).message}`);
  process.exit(1);
}
console.log(`Database: ${describeTarget(target)}`);
const ctx = createContext(store, {
  publicUrl: (env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
  token,
  env,
  draftTtlMs: 30 * 60 * 1000,
  topUpTtlMs: 24 * 60 * 60 * 1000,
  dashboardOrigins: (env.DASHBOARD_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(
    ",",
  ),
});

await listen(ctx, port);
console.log(`syndromi server on http://localhost:${port} (public: ${ctx.config.publicUrl})`);
startSweeper(ctx);

if ((env.SYNDROMI_HOSTED_SECRET ?? "").length >= 32) {
  const scheduled = env.SYNDROMI_HOSTED_SCHEDULE !== "off";
  const hosted = new HostedRuntime(ctx, { schedule: scheduled, log: (line) => console.log(line) });
  ctx.hosted = hosted;
  hosted.start();
  console.log(`Hosted runtime: on${scheduled ? "" : " (schedules off: Run now only)"}.`);
} else {
  console.log("Hosted runtime: off (set SYNDROMI_HOSTED_SECRET, 32+ characters).");
}

try {
  const treasury = await loadTreasury(env);
  if (treasury) {
    ctx.treasury = treasury;
    const sol = await treasurySol(ctx);
    console.log(
      `Test-token faucet: on (${faucetAmount(env)} test USDC per wallet per day; treasury ` +
        `${treasury.address} holds ${sol ?? "an unknown amount of"} devnet SOL).`,
    );
    if (sol !== undefined && sol < TREASURY_LOW_SOL) {
      console.warn("Treasury is low on devnet SOL: top it up or the faucet will stop working.");
    }
  } else {
    console.log("Test-token faucet: off (SYNDROMI_TREASURY_KEY not set).");
  }
} catch (e) {
  console.error(`Test-token faucet: off, the treasury key is unusable: ${(e as Error).message}`);
}

if (env.TELEGRAM_BOT_TOKEN) {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET || undefined;
  const telegram = await createTelegram(ctx, {
    token: env.TELEGRAM_BOT_TOKEN,
    ...(webhookSecret ? { webhookSecret } : {}),
  });
  ctx.telegram = telegram;
  await telegram.start();
  console.log(
    `Telegram: @${telegram.bot.botInfo.username} by ${webhookSecret ? "webhook" : "long polling"}; ` +
      "owners connect it from the dashboard (Connect Telegram).",
  );
  process.once("SIGINT", () => void telegram.stop().then(() => process.exit(0)));
} else {
  console.log("Telegram: disabled (TELEGRAM_BOT_TOKEN not set).");
}

/** Where the data lives, without credentials. */
function describeTarget(target: string) {
  if (!/^postgres(ql)?:\/\//.test(target)) return `SQLite ${target}`;
  try {
    const url = new URL(target);
    return `Postgres ${url.hostname}${url.pathname}`;
  } catch {
    return "Postgres";
  }
}
