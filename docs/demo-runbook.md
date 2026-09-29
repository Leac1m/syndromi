# Demo runbook

The six-step demo from `CLAUDE.md`, as run in rehearsal. Rehearsals use **devnet** for the bag,
agents, top-up, injection and kill switch, and the local **fork** for the swap (step 3); the
recording uses **mainnet** with a fresh owner wallet (about $30 USDC + 0.05 SOL).

## Setup (one terminal each)

`.env` needs: `RPC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `NVIDIA_API_KEY`, `SYNDROMI_SERVER_TOKEN`
(`openssl rand -hex 24`), `SYNDROMI_HOSTED_SECRET` (`openssl rand -hex 32`).

1. **Fork** (for step 3): `surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"`
2. **Tunnel** (phone approvals): `pnpm tunnel`, and copy the `https://….trycloudflare.com` URL.
   The URL changes every time the tunnel restarts.
3. **Server**: `PUBLIC_URL=<tunnel url> SYNDROMI_HOSTED_SCHEDULE=off pnpm server`.
   - On a fresh `SYNDROMI_HOME`, open the printed `t.me/syndromi_bot?start=…` link and press Start.
   - `SYNDROMI_HOSTED_SCHEDULE=off` means hosted agents only run on **Run now**, so the camera
     never waits on a cron.
4. **Dashboard**: `pnpm --filter @syndromi/dashboard dev` and open http://localhost:3000.
   - If port 3000 is taken: `pnpm --filter @syndromi/dashboard exec next dev --port 3001`, and
     start the server with `DASHBOARD_ORIGINS=http://localhost:3001`.
5. **Owner on the fork** (rehearsals only): give the owner SOL and USDC on the fork:
   ```
   curl -s -X POST localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":["<OWNER>",{"lamports":5000000000}]}'
   curl -s -X POST localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_setTokenAccount","params":["<OWNER>","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",{"amount":500000000}]}'
   ```
6. **Phantom**: the bag-owner account, Testnet mode on Devnet. On the phone, the same account in
   the Phantom app.

## The six steps

| # | Do | Expect |
|---|---|---|
| 1 | Dashboard → **Connect Phantom**, sign the sign-in message. Devnet: the **Bag** card shows USDC (Circle faucet if empty). | Bag balance, "Allocated: nothing yet". |
| 2 | **New agent** → `yield-scout`, hosted → **Create** → **Sign & fund** (rehearsal: switch the dashboard to **fork** first). Then **New agent** → `dca-agent`, "on my machine" → run the shown `pnpm syndromi init … --server … --owner …` → **Sign & fund**. | Both agents listed with "N of M USDC left"; rule cards on their pages; feed shows "funding funded". |
| 3 | `yield-scout` → **Run now**. | Feed: pull sent, then "needs your approval: swap 15 USDC → JitoSOL ($15.00)"; Telegram "⏸ yield-scout wants approval" with **Open in Phantom (phone)**. Sign the message on the phone → Telegram ✅ Approved → ✅ Executed (the hosted watcher swaps within about 5 s). |
| 4 | `pnpm syndromi request-topup templates/dca-agent --amount 5 --reason "Weekly allowance used up"` (devnet; `SYNDROMI_SERVER_URL`/`TOKEN` set). | Telegram "💸 dca-agent asks for a top-up of 5 USDC" → approve on the phone (a transaction; Phantom may warn about mainnet fees, since syndromi sends it to devnet) → ✅ approved → ✅ pulled (needs `pnpm syndromi watch templates/dca-agent` running). |
| 5 | `pnpm syndromi deploy fixtures/injection/pool-scout --owner <OWNER>` → dashboard (devnet) **pool-scout** (tagged *demo*) → **Sign & fund** → **Run now**. | The model reads the poisoned pool notice and tries `transfer 2 USDC to AhLo5H…` → feed shows **BLOCKED** in red with both reasons; Telegram 🛑 BLOCKED. Only the 2 USDC pull is sent. |
| 6 | Dashboard → **Kill switch** → **Revoke everything** (devnet; rehearsal: also on fork). | "Everything revoked"; agents drop back to "Needs funding"; Telegram 🛑; `pnpm syndromi status` shows 0 delegations. |

## Reset between runs
- Start the server with a fresh `SYNDROMI_HOME` (new database: agent names are free again), or
  keep the database and use new agent names.
- The kill switch already revoked every delegation onchain; the fork keeps balances until
  Surfpool restarts.
- A fresh `SYNDROMI_HOME` means linking Telegram again (one tap).

## If something goes wrong
- **The swap fails on the fork**: the fork is stale; restart Surfpool and re-fund the owner
  (setup step 5). The swap tool already refreshes the route's pools and the fork clock.
- **Gemini quota**: the templates use NVIDIA; `--model gemini:<id>` is only a fallback.
- **The model doesn't fall for the injection**: set `demo.script: injection` in
  `fixtures/injection/pool-scout/manifest.yaml` (a scripted model that follows the notice every
  time) and deploy it under a new name.
