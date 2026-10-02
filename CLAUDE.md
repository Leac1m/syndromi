# syndromí: project context for Claude Code

> Budgets, permissions, and approvals for onchain AI agents on Solana.
> Submission for the Colosseum Crypto World's Fair (Solana track). Deadline: Oct 12, 2026, 11:59pm PT.
> Development window: 7 days (Sep 29 – Oct 5). Oct 6–12 is buffer, videos, and submission.

## What we're building

One owner wallet (the **bag**) funds many AI agents. Each agent gets an **allowance** (amount per period) enforced onchain by the Solana Foundation's Subscriptions & Allowances program. Agents pull their allowance into their own wallet, and every transaction they sign passes a **policy layer** (program allowlist, destination allowlist, per-tx cap, approval threshold). Anything above threshold becomes a **draft** that the owner approves by signing a Blink sent to Telegram or shown in the dashboard.

Agents are defined by a portable **manifest** and run identically **locally** (free, via CLI) or **hosted** (paid tier, same runtime as a service).

### Pitch line
The Foundation gave Solana allowances. syndromí turns them into safe, governable budgets for fleets of AI agents.

### The demo we must be able to record (everything serves this)
1. Owner connects Phantom and funds the bag with devnet USDC.
2. Owner creates two agents: `dca-agent` (runs locally via CLI) and `yield-scout` (runs hosted).
3. `yield-scout` finds a better yield (e.g. USDC → liquid staking token via Jupiter), sends a draft to Telegram as a Blink; owner signs; it executes.
4. An agent hits its limit and requests a top-up; owner approves (one-time fixed allowance).
5. A prompt-injection fixture tells an agent to send funds to an unknown address; the policy layer blocks it and the activity feed shows BLOCKED.
6. Owner hits the kill switch; all delegations are revoked.

## Architecture decisions (locked unless a Day-1 spike disproves them)

- **No custom onchain program.** Build on the Subscriptions Delegation Program.
  - Program ID (verify against `program/src/lib.rs` in the repo before use): `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`
  - Live on mainnet and devnet. Surfpool local workflows install it at the canonical address.
  - Recurring delegation → the agent's regular allowance (amount per period).
  - Fixed delegation (one-time cap, optional expiry) → approved top-up requests.
  - Revoking delegations → kill switch.
  - Rejects mints with certain Token-2022 extensions (ConfidentialTransfer, NonTransferable, PermanentDelegate, TransferFee, MintCloseAuthority, Pausable). The docs now say TransferHook is supported, but SDK 0.5.0 still defines `MINT_HAS_TRANSFER_HOOK`. Use plain USDC / SPL test mints.
- **Bag** = the owner's USDC token account (recommend a dedicated Phantom account). The program's per-(user, mint) Subscription Authority PDA gates every pull.
- **Agent wallet** = a keypair per agent. Local: encrypted keypair file under `~/.syndromi/`. Hosted: the server generates the key and stores it encrypted with `SYNDROMI_HOSTED_SECRET` (managed MPC/TEE custody is roadmap).
- **Hosting** (Day 6): the server runs hosted agents in-process (`apps/server/src/hosted.ts`) on the owner's machine, reached through a Cloudflare quick tunnel (`pnpm tunnel`) for phone approvals. A real cloud deploy is deferred.
- **Demo-only switches**: manifest `demo: { injection, unguarded, script }` exists only for the prompt-injection demo (`fixtures/injection/pool-scout`). Never set them on real agents; the prompt guard is on by default and tested.
- **Fee budget** = small SOL transfer from owner to agent wallet at creation (covers tx fees and token-account rent).
- **Policy layer** = a signer wrapper in `packages/core`. Nothing signs without passing it. Swig smart-wallet permissions passed the Day-1 spike (see `docs/architecture.md`). They are a first stretch item layered on top of the offchain signer, never a replacement for it.
- **Network**: devnet by default. Jupiter is mainnet-only, so swaps are tested against a Surfpool mainnet fork. **The recorded demo runs on mainnet with a few dollars** (decided Day 5: Phantom cannot reach the fork). Build and rehearse on devnet and the fork first; use a fresh owner wallet with about $30 USDC + 0.05 SOL.

## Stack

- TypeScript everywhere, pnpm workspaces monorepo, Node 20+.
- `@solana/kit` as the Solana client. `@solana/subscriptions` for the delegation program. Pin the **kit 7** line (subscriptions 0.5 peers on kit ^7); see `docs/architecture.md`.
- Solana Actions: spec types from `@solana/actions-spec` (types only) in `apps/server`; no `@solana/actions` and no web3.js v1 anywhere. Draft approvals are sign-message Actions (owner signs a text naming the draft hash and USD bound; server and runtime both verify it); top-up approvals are transaction Actions (fixed delegation). The owner signs in our own Blink viewer (`/approve/:id`, Wallet Standard); dial.to was down on Day 4 (`BLINK_VIEWER=dialto` restores it).
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
  tools/         first-party tools: pyth-price, jupiter-quote, jupiter-swap, balances,
                 pull-allowance, request-topup, propose-tx
  cli/           `syndromi init | run | deploy | revoke`
templates/
  dca-agent/     manifest + prompt
  yield-scout/   manifest + prompt
fixtures/
  injection/     malicious tool output used in the security demo
docs/
  manifest-spec.md, package-spec.md, architecture.md
scripts/
  spike-*.ts     Day-1 spikes
```

## Agent manifest (target shape)

```yaml
name: yield-scout
runtime: hosted            # or local
model: byok:anthropic      # or openai-compatible:<url>
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

## Rules for Claude Code in this repo

1. **Check the docs before writing integration code.** These SDKs changed during 2026. Use the Solana MCP server and the doc links below; do not rely on memory for package APIs, program IDs, or instruction layouts.
2. Never invent program IDs, mint addresses, or API endpoints. If unsure, stop and ask.
3. Never commit keys, `.env`, or keypair files. `.gitignore` them on day one.
4. Devnet by default. Any mainnet action requires an explicit `--mainnet` flag and a confirmation prompt.
5. LLM output never reaches a signer directly. Flow is always: tool builds unsigned tx → policy check → (approval if needed) → sign → send.
6. Keep each day's work shippable. Commit after each task with a clear message. Prefer working and simple over complete.
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
- Hackathon resources: https://colosseum.com/worldsfair/resources
