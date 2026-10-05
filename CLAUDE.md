# syndromí: project context for Claude Code

> Budgets, permissions, and approvals for onchain AI agents on Solana.
> syndromí is a product built for real users, not a hackathon entry. Judge every decision by what users need: correctness, safety of funds, and something we can maintain.
> Current stage: devnet beta with testers (`docs/beta-design.md`). Work is organised in phases (`PLAN.md`), not days.
> The Colosseum submission is one dated milestone in `PLAN.md`. It never sets scope, priorities, or quality bars.

## What we're building

One owner wallet (the **bag**) funds many AI agents. Each agent gets an **allowance** (amount per period) enforced onchain by the Solana Foundation's Subscriptions & Allowances program. Agents pull their allowance into their own wallet, and every transaction they sign passes a **policy layer** (program allowlist, destination allowlist, per-tx cap, approval threshold). Anything above threshold becomes a **draft** that the owner approves by signing a Blink sent to Telegram or shown in the dashboard.

Agents are defined by a portable **manifest** and run identically **locally** (free, via CLI) or **hosted** (paid tier, same runtime as a service).

### Pitch line
The Foundation gave Solana allowances. syndromí turns them into safe, governable budgets for fleets of AI agents.

### The core flow (must keep working end to end)
1. Owner connects Phantom and funds the bag with devnet USDC.
2. Owner creates two agents: `dca-agent` (runs locally via CLI) and `yield-scout` (runs hosted).
3. `yield-scout` finds a better yield (e.g. USDC → liquid staking token via Jupiter), sends a draft to Telegram as a Blink; owner signs; it executes.
4. An agent hits its limit and requests a top-up; owner approves (one-time fixed allowance).
5. A prompt-injection fixture tells an agent to send funds to an unknown address; the policy layer blocks it and the activity feed shows BLOCKED.
6. Owner hits the kill switch; all delegations are revoked.

## Architecture decisions (backed by the Phase-1 spikes; change one only with the reason recorded in `docs/architecture.md`)

- **No custom onchain program.** Build on the Subscriptions Delegation Program.
  - Program ID (verify against `program/src/lib.rs` in the repo before use): `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`
  - Live on mainnet and devnet. Surfpool local workflows install it at the canonical address.
  - Recurring delegation → the agent's regular allowance (amount per period).
  - Fixed delegation (one-time cap, optional expiry) → approved top-up requests.
  - Revoking delegations → kill switch.
  - Rejects mints with certain Token-2022 extensions (ConfidentialTransfer, NonTransferable, PermanentDelegate, TransferFee, MintCloseAuthority, Pausable). The docs now say TransferHook is supported, but SDK 0.5.0 still defines `MINT_HAS_TRANSFER_HOOK`. Use plain USDC / SPL test mints.
- **Bag** = the owner's USDC token account (recommend a dedicated Phantom account). The program's per-(user, mint) Subscription Authority PDA gates every pull.
- **Agent wallet** = a keypair per agent. Local: encrypted keypair file under `~/.syndromi/`. Hosted: the server generates the key and stores it encrypted with `SYNDROMI_HOSTED_SECRET` (managed MPC/TEE custody is roadmap).
- **Hosting** (Phase 6): the server runs hosted agents in-process (`apps/server/src/hosted.ts`). Locally it is reached through a Cloudflare quick tunnel (`pnpm tunnel`) for phone approvals; the beta runs on Render + Neon + Vercel (see `docs/beta-design.md`, "Running now").
- **Scripted agents** (Beta phase 6): `model: script:tour` runs a fixed list of tool calls instead of an LLM (`tourScript` in `packages/runtime/src/llm/index.ts`), through the same loop and policy. It needs no key, schedule or prompt. A scripted run is interactive: it paces its moves and, in the hosted runtime, waits for the owner's answer to each held request (`awaitOwner` in `packages/runtime/src/loop.ts`), ending the run on a rejection. `templates/guided-tour` uses it for the dashboard's "Try a guided run"; a test keeps the script's amounts in step with that template's rules.
- **Demo-only switches**: manifest `demo: { injection, unguarded, script }` exists only for the prompt-injection demo (`fixtures/injection/pool-scout`). Never set them on real agents; the prompt guard is on by default and tested.
- **Telegram can only tighten** (Beta phase 7): the bot may reject, pause an agent, and revoke its AI's access tokens, none of which need a signature. Approving, resuming and anything that raises a limit stay in the wallet or the signed-in dashboard, so a stolen Telegram account can never give an agent more room. Never add a bot button that loosens. Pause (`apps/server/src/pause.ts`) is a server-enforced flag for agents whose key the server holds; it revokes nothing onchain.
- **Fee budget** = small SOL transfer from owner to agent wallet at creation (covers tx fees and token-account rent).
- **Policy layer** = a signer wrapper in `packages/core`. Nothing signs without passing it. Swig smart-wallet permissions passed the Phase-1 spike (see `docs/architecture.md`). They are a first stretch item layered on top of the offchain signer, never a replacement for it.
- **Devnet test tokens** (Beta phase 4): on devnet, `USDC` and `JitoSOL` in the token registry (`packages/core/src/tokens.ts`) are syndromí's own test mints, the devnet twins of the mainnet tokens (same symbol and decimals, priced as the mainnet token, worth nothing). The beta treasury (`SYNDROMI_TREASURY_KEY`, devnet only) is their mint authority; `pnpm beta:setup` creates them and `POST /owner/faucet` hands out test USDC, one claim per wallet per day. Circle's devnet USDC is not used. Testers get devnet SOL from the public faucet themselves.
- **Devnet swaps** (Beta phase 5): an Orca Splash Pool (full range) of the two test tokens, traded with the `orca-quote` and `orca-swap` tools under the `orca` program permission; devnet only. Every Orca import lives in `packages/tools/src/orca.ts`. `@orca-so/whirlpools` is pinned to 8.0.1: it declares a peer on kit ^5 and runs under our kit 7 (allowed in `pnpm-workspace.yaml`), so run `pnpm spike:orca` again before moving the pin. The server's keeper (`apps/server/src/beta/keeper.ts`) holds the pool near the live price.
- **Network**: devnet by default. Jupiter is mainnet-only, so on devnet agents swap on the Orca test pool, and Jupiter swaps are tested against a Surfpool mainnet fork. **Wallet-signed swaps can only be shown end to end on mainnet** (decided Phase 5: Phantom cannot reach the fork), so mainnet runs use a few dollars. Build and rehearse on devnet and the fork first; use a fresh owner wallet with about $30 USDC + 0.05 SOL.

## Stack

- TypeScript everywhere, pnpm workspaces monorepo, Node 20+.
- `@solana/kit` as the Solana client. `@solana/subscriptions` for the delegation program. Pin the **kit 7** line (subscriptions 0.5 peers on kit ^7); see `docs/architecture.md`.
- Solana Actions: spec types from `@solana/actions-spec` (types only) in `apps/server`; no `@solana/actions` and no web3.js v1 anywhere. Draft approvals are sign-message Actions (owner signs a text naming the draft hash and USD bound; server and runtime both verify it); top-up approvals are transaction Actions (fixed delegation). The owner signs in our own Blink viewer (`/approve/:id`, Wallet Standard); dial.to was down on Phase 4 (`BLINK_VIEWER=dialto` restores it).
- LLM: provider-agnostic interface. Anthropic (BYOK, official `@anthropic-ai/sdk`, default `claude-opus-5-5` with server-side `fallbacks: "default"`) and any OpenAI-compatible endpoint (for open models). Test model: NVIDIA `meta/muse-glimmer-30b` via `https://integrate.api.nvidia.com/v1` (`NVIDIA_API_KEY`); Gemini is a quota-limited fallback (`run --model gemini:<id>`). A backup model (`SYNDROMI_FALLBACK_MODEL` or manifest `fallback_model`, e.g. `anthropic:claude-opus-5-5`) takes over when the primary fails on a run's first request.
- Tools follow an MCP-compatible shape (`name`, `description`, `inputSchema`) plus a permission manifest: `kind: "read" | "write"`. Only `write` tools may produce transactions, and they only return **unsigned** transactions to the policy signer.
- Prices: a `PriceSource` in `packages/core`. Keyless Jupiter Price API v3 by default. When `PYTH_API_KEY` is set, Pyth Hermes goes first and Jupiter fills any gap per request (Hermes has required a key since the Aug 26, 2026 Pyth Core upgrade; our key is a 14-day trial from Sep 29 and lacks the mSOL feed). Swaps: Jupiter Swap API v2 `/build`, with `maxAccounts` stepped down when a route won't fit in 1232 bytes.
- Server: Hono. Persistence: one async `Store` (`apps/server/src/db.ts`) over Node's built-in `node:sqlite` by default, or Postgres when `DATABASE_URL` is set (hosted: Neon, decided Oct 2 because Render's free tier wipes local files).
- Dashboard: Next.js 16 + `@phantom/react-sdk` (Phantom Connect, extension only for now). It connects and signs messages through the SDK and signs transactions through the Wallet Standard (`solana:signTransaction`, raw bytes; the SDK's signTransaction expects web3.js objects). The dashboard is a Blink client over the server's Actions: the server builds every owner transaction and sends it after the wallet signs.
- Telegram: grammY.
- Tests: Vitest; LiteSVM or Surfpool for transaction-level tests.

## Repo layout

```
apps/
  dashboard/     Next.js: bag, agent wizard, rule card, activity feed, kill switch
  server/        approvals API, Solana Actions/Blinks endpoints, Telegram bot, hosted runtime host
packages/
  core/          bag client, delegation helpers, agent wallet, policy signer, manifest schema (zod)
  runtime/       agent loop, LLM providers, tool registry, scheduler
  tools/         first-party tools: pyth-price, jupiter-quote, jupiter-swap, orca-quote,
                 orca-swap, balances, pull-allowance, request-topup, propose-tx
  cli/           `syndromi init | run | deploy | revoke`
templates/
  dca-agent/     manifest + prompt
  yield-scout/   manifest + prompt
  mcp-agent/     manifest + prompt (external: your own AI is the brain; the wizard's default)
  guided-tour/   manifest only (scripted: the guided run)
fixtures/
  injection/     malicious tool output used in the security demo
docs/
  manifest-spec.md, package-spec.md, architecture.md
scripts/
  spike-*.ts     Phase-1 spikes, and spike-orca.ts (Beta phase 5)
  beta-setup.ts  devnet test tokens and the Orca test pool (pnpm beta:setup)
```

## Agent manifest (target shape)

```yaml
name: yield-scout
runtime: hosted            # or local
model: byok:anthropic      # or openai-compatible:<url>, or script:tour (no LLM, no key)
model_id: claude-opus-5-5  # required for openai-compatible, e.g. gemini-3.8-flash
fallback_model: anthropic:claude-opus-5-5  # optional backup; else SYNDROMI_FALLBACK_MODEL
api_key_env: ANTHROPIC_API_KEY  # name of the env var holding the key, never the key
schedule: "*/15 * * * *"
allowance: { mint: USDC, amount: 50, period: weekly }
fee_budget: { sol: 0.02 }
permissions:
  programs: [jupiter]
  destinations: [self]
  max_tx_usd: 25
  approve_above_usd: 10
tools: [pyth-price, jupiter-quote, jupiter-swap, balances, pull-allowance, request-topup]
prompt: ./prompt.md
```

## Words users see (Beta phase 8)

Code, API fields, manifest keys and these internal docs keep their names (`bag`, `draft`, `delegation`, `fee_budget`). Anything an owner or their AI reads uses the words on the right: the dashboard, landing page, Telegram, approval pages, Action cards, rule cards, tool descriptions, the agent's system prompt, CLI output and the README.

| In code | Users see |
|---|---|
| bag | your wallet |
| agent wallet | the agent's wallet |
| draft | approval request |
| Blink | approval link |
| delegation (recurring / fixed) | allowance / top-up |
| fee budget | SOL for network fees |
| runtime external / hosted / local | your AI / hosted / on your machine |

Kill switch, top-up, allowance and BLOCKED are already the user's words. One exception: the text an owner signs to approve a request (`approvalMessage` in `packages/core/src/approval.ts`) still says "draft". It is parsed line by line and verified by the server and by runtimes that may be on an older version, so reword it only together with a format version.

## Rules for Claude Code in this repo

1. **Check the docs before writing integration code.** These SDKs changed during 2026. Use the Solana MCP server and the doc links below; do not rely on memory for package APIs, program IDs, or instruction layouts.
2. Never invent program IDs, mint addresses, or API endpoints. If unsure, stop and ask.
3. Never commit keys, `.env`, or keypair files. `.gitignore` them on day one.
4. Devnet by default. Any mainnet action requires an explicit `--mainnet` flag and a confirmation prompt.
5. LLM output never reaches a signer directly. Flow is always: tool builds unsigned tx → policy check → (approval if needed) → sign → send.
6. Keep each phase's work shippable. Commit after each task with a clear message. Prefer working and simple over complete.
7. When a task in `PLAN.md` is done, tick it and note anything deferred.

## Docs

- Subscriptions overview: https://solana.com/docs/payments/subscriptions/overview
- Subscription plan guide (install line, PDAs): https://solana.com/docs/payments/subscriptions/subscription-plan
- Subscriptions explainer (Chainstack): https://docs.chainstack.com/docs/solana-subscriptions-and-allowances
- Helius integration write-up: https://www.helius.dev/blog/solana-subscriptions-recurring-payments
- Solana payments map (incl. x402): https://solana.com/docs/payments
- Kit (TS client): https://solana.com/docs/clients/official/javascript
- Solana Actions & Blinks: https://solana.com/docs/tools/actions
- Dialect Blinks docs: https://docs.dialect.to/blinks
- Swig docs: https://build.onswig.com/ · TS tutorial: https://build.onswig.com/tutorials/typescript
- Phantom Connect: https://docs.phantom.com/phantom-connect
- Jupiter docs index (LLM-friendly): https://dev.jup.ag/docs/llms.txt
- Pyth on Solana: https://docs.pyth.network/price-feeds/use-real-time-data/solana
- Surfpool: https://solana.com/docs/tools/surfpool · LiteSVM: https://solana.com/docs/tools/litesvm
- x402 on Solana: https://solana.com/docs/payments/agentic-payments/intro-to-x402
- Solana MCP (docs retrieval for coding agents): https://mcp.solana.com/
- Solana Agent Skills: https://solana.com/skills
