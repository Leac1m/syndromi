# Demo runbook

The six-step demo from `CLAUDE.md`, as run in rehearsal. Rehearsals use **devnet** for the bag,
agents, top-up, injection and kill switch, and the local **fork** for the swap (step 3); the
recording uses **mainnet** with a fresh owner wallet (about $30 USDC + 0.05 SOL).

## Setup (one terminal each)

`.env` needs: `RPC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `NVIDIA_API_KEY`, `SYNDROMI_SERVER_TOKEN`
(`openssl rand -hex 24`), `SYNDROMI_HOSTED_SECRET` (`openssl rand -hex 32`), and for the backup
model `ANTHROPIC_API_KEY` plus `SYNDROMI_FALLBACK_MODEL=anthropic:claude-opus-5-5`. If NVIDIA
stops answering, a run switches to Anthropic by itself, and the feed shows "switched to …".

1. **Fork** (for step 3): `surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"`
2. **Tunnel + server**: `pnpm demo:up`. It starts a Cloudflare quick tunnel, then the server with
   `PUBLIC_URL` set to it and hosted schedules off (agents run only on **Run now**, so the camera
   never waits on a cron). Ctrl-C stops both.
   - On a fresh `SYNDROMI_HOME`, open the printed `t.me/syndromi_bot?start=…` link and press Start.
   - The URL changes on every start; Telegram buttons use the new one automatically.
3. **Dashboard**: `NEXT_PUBLIC_SHOW_FORK=1 pnpm --filter @syndromi/dashboard dev` and open http://localhost:3000/app (the landing page is at `/`). Without that variable the network switcher offers only devnet and mainnet.
   - If port 3000 is taken: `pnpm --filter @syndromi/dashboard exec next dev --port 3001`, and
     start with `DASHBOARD_ORIGINS=http://localhost:3001 pnpm demo:up`.
4. **Owner on the fork** (rehearsals only): give the owner SOL and USDC on the fork:
   ```
   curl -s -X POST localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":["<OWNER>",{"lamports":5000000000}]}'
   curl -s -X POST localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"surfnet_setTokenAccount","params":["<OWNER>","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",{"amount":500000000}]}'
   ```
5. **Phantom**: the bag-owner account, Testnet mode on Devnet. On the phone, the same account in
   the Phantom app.
6. **dca-agent with a small allowance** (for step 4): copy the template and set
   `allowance: { mint: USDC, amount: 2, period: weekly }` before creating it:
   `cp -r templates/dca-agent /tmp/dca-agent` and edit `/tmp/dca-agent/manifest.yaml`.

## The six steps

| # | Do | Expect |
|---|---|---|
| 1 | Dashboard → **Connect Phantom**, sign the sign-in message. Devnet: the **Bag** card shows test USDC (**Get 100 test USDC** if empty). | Bag balance, "Allocated: nothing yet". |
| 2 | **New agent** → `yield-scout`, hosted → **Create** → **Sign & fund** (rehearsal: switch the dashboard to **fork** first). Then **New agent** → `dca-agent`, "on my machine" → run the shown `pnpm syndromi init … --server … --owner …` with `/tmp/dca-agent` in place of `templates/dca-agent` → **Sign & fund**. | Both agents listed with "N of M USDC left"; rule cards on their pages; feed shows "funding funded". |
| 3 | `yield-scout` → **Run now**. The button shows **Running…**, then **Finished ✓** with the summary. | Feed: pull sent, then "needs your approval: swap 15 USDC → JitoSOL ($15.00)"; Telegram "⏸ yield-scout wants approval" with **Open in Phantom (phone)**. Sign the message on the phone → Telegram ✅ Approved → ✅ Executed (the hosted watcher swaps within about 5 s). |
| 4 | `pnpm syndromi run /tmp/dca-agent --once --server http://127.0.0.1:8787` (devnet), with `pnpm syndromi watch /tmp/dca-agent --server http://127.0.0.1:8787` running in another terminal. | The agent tries to pull 3 USDC; `pull-allowance` answers "Only 2 USDC left… ask the owner once with request-topup"; the agent asks for 3 USDC itself → feed "asked for a top-up"; Telegram "💸 dca-agent asks for a top-up of 3 USDC" → approve on the phone (a transaction; Phantom may warn about mainnet fees, since syndromi sends it to devnet) → ✅ approved → ✅ pulled. Manual fallback: `pnpm syndromi request-topup /tmp/dca-agent --amount 3 --reason "Weekly allowance used up"`. |
| 5 | `pnpm syndromi deploy fixtures/injection/pool-scout --owner <OWNER>` → dashboard (devnet) **pool-scout** (tagged *demo*) → **Sign & fund** → **Run now**. | The model reads the poisoned pool notice and tries `transfer 2 USDC to AhLo5H…` → feed shows **BLOCKED** in red with both reasons; Telegram 🛑 BLOCKED. Only the 2 USDC pull is sent. |
| 6 | Dashboard → **Kill switch** → **Revoke everything** (devnet; rehearsal: also on fork). | "Everything revoked"; agents drop back to "Needs funding"; Telegram 🛑; `pnpm syndromi status` shows 0 delegations. |

## Reset between runs
- After the kill switch, **Remove agent** on each agent's page frees its name (hosted keys are
  archived, not deleted). Or start with a fresh `SYNDROMI_HOME` (new database), or use new names.
- A local agent's key stays under `~/.syndromi/agents/<name>`; delete that folder (or use a fresh
  `SYNDROMI_HOME`) before `init` reuses the name.
- The kill switch already revoked every delegation onchain; the fork keeps balances until
  Surfpool restarts.
- A fresh database means linking Telegram again: dashboard → **Connect Telegram** → open the link → Start.

## If something goes wrong
- **The swap fails on the fork**: the fork is stale; restart Surfpool and re-fund the owner
  (setup step 5). The swap tool already refreshes the route's pools and the fork clock.
- **NVIDIA doesn't answer**: with `SYNDROMI_FALLBACK_MODEL` set, the run switches to Anthropic
  (feed: "model … failed; switched to …") and NVIDIA is skipped for 10 minutes. Without it,
  **Run now** shows "Failed: NVIDIA meta/muse-glimmer-30b did not respond…".
- **Gemini quota**: the templates use NVIDIA; `--model gemini:<id>` is only a fallback.
- **The model doesn't fall for the injection**: set `demo.script: injection` in
  `fixtures/injection/pool-scout/manifest.yaml` (a scripted model that follows the notice every
  time) and deploy it under a new name. It is tagged *demo* in the dashboard; say on camera that
  this is the scripted stand-in for a fooled model.
