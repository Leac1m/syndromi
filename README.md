# syndromí

**Budgets, permissions and approvals for onchain AI agents on Solana.**

The Solana Foundation gave Solana allowances. syndromí turns them into safe, governable budgets
for fleets of AI agents.

One owner wallet (the **bag**) funds many agents:
- Each agent gets an **allowance** (an amount per period) that the Subscriptions & Allowances
  program enforces onchain.
- Every transaction an agent wants to sign passes a **policy layer**: allowed programs, allowed
  destinations, a per-transaction cap and an approval threshold.
- Anything above the threshold becomes a **draft**. The owner approves it by signing a Blink,
  from Telegram (phone) or the dashboard.
- One **kill switch** revokes every allowance.

Built for the Colosseum Crypto World's Fair (Solana track). MIT licensed.

## Why now

Giving an AI agent a wallet today means giving it a hot key and hoping. The
[Subscriptions Delegation Program](https://solana.com/docs/payments/subscriptions/overview)
(`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, live on mainnet and devnet) lets a wallet grant
another key a recurring or one-time pull right, capped onchain. That is the missing primitive for
agent budgets. syndromí adds what an owner of many agents needs on top:
- per-agent rules;
- approvals on the owner's phone;
- a live activity feed;
- one-click revocation.

## Quickstart with an agent you already have (devnet)

The default template, `mcp-agent`, is a budgeted wallet for Claude, Cursor or any MCP client.
There is no model to configure: the client is the brain.

```bash
pnpm install
pnpm syndromi init                       # creates mcp-agent and its encrypted key
pnpm syndromi fund templates/mcp-agent   # owner: fee budget + a 5 USDC/week allowance
# init printed a `claude mcp add …` line; run it, restart Claude Code, and ask it to check balances
```

## Quickstart with a built-in agent (devnet, about 60 seconds)

Needs Node 20+, pnpm, and a devnet wallet at `~/.config/solana/id.json` (or `OWNER_KEYPAIR`) holding
a little devnet SOL and devnet USDC ([Circle faucet](https://faucet.circle.com)). You also need a
model key: the `dca-agent` template uses NVIDIA's free API catalog (`NVIDIA_API_KEY`).

```bash
pnpm install
cp .env.example .env                     # add NVIDIA_API_KEY (RPC_API_KEY optional)

pnpm syndromi init templates/dca-agent   # the agent's own encrypted key, under ~/.syndromi
pnpm syndromi fund templates/dca-agent   # owner: fee budget + a 20 USDC/week allowance
pnpm syndromi run templates/dca-agent --once
pnpm syndromi status                     # what each agent may still pull
pnpm syndromi revoke --all               # the kill switch
```

`run` prints each step: the model's tool calls, the policy's verdict on each transaction, what
was sent (with explorer links), and anything held for approval.

The dashboard and phone approvals:
1. Add `SYNDROMI_SERVER_TOKEN` (`openssl rand -hex 24`), `SYNDROMI_HOSTED_SECRET`
   (`openssl rand -hex 32`) and `TELEGRAM_BOT_TOKEN` to `.env`.
2. Run `pnpm demo:up` (tunnel + server), then `pnpm --filter @syndromi/dashboard dev`.
3. Open http://localhost:3000 and connect Phantom.

The full six-step demo is in [`docs/demo-runbook.md`](docs/demo-runbook.md).

## How it works

```
             owner (Phantom): funds the bag, grants and revokes allowances, signs approvals
                                         │
      bag = owner's USDC account ── Subscriptions Delegation Program
                                         │  recurring delegation = allowance
                                         │  fixed delegation     = approved top-up
                                         ▼  revoke               = kill switch
  agent wallet ◄── pull (capped onchain) ──┘
       │
       │  model → tools → UNSIGNED transaction + intent
       ▼
  policy signer ── allow ─────────► sign & send
       ├── needs_approval ──► draft → Telegram / dashboard Blink → owner signs → execute
       └── block ───────────► never signed; BLOCKED in the feed and on Telegram
```

| Package | What it is |
|---|---|
| `packages/core` | bag and delegation helpers, agent wallets, the **policy signer**, manifest schema, prices |
| `packages/tools` | first-party tools: `balances`, `pyth-price`, `jupiter-quote`, `jupiter-swap`, `pull-allowance`, `request-topup`, `propose-tx`, `yield-data` |
| `packages/runtime` | agent loop, LLM providers (Anthropic, any OpenAI-compatible endpoint, failover), approvals watcher |
| `packages/cli` | `syndromi init · fund · run · watch · deploy · approve · action · request-topup · status · revoke` |
| `apps/server` | approvals API, Solana Actions/Blinks, the Telegram bot, the hosted runtime (Hono + SQLite) |
| `apps/dashboard` | Next.js: bag, agent wizard, rule cards, activity feed, Run now, kill switch |

An agent is a portable directory (`manifest.yaml` + `prompt.md`) that runs **locally** (free,
through the CLI) or **hosted** (the same runtime inside the server). See
[`docs/manifest-spec.md`](docs/manifest-spec.md) and [`docs/package-spec.md`](docs/package-spec.md).
Design decisions and their evidence: [`docs/architecture.md`](docs/architecture.md).

## Use it from any MCP client

`syndromi mcp <dir>` lets Claude, Cursor or any MCP client act as a funded agent. The client
gets the agent's tools and the owner's rule card, never a key, and every write goes through
the same policy signer: executed, held for the owner's signature, or blocked. See
[`docs/package-spec.md`](docs/package-spec.md#using-a-syndromí-agent-from-another-agent-mcp).

## Security model

- **The budget is enforced onchain.** An agent can only pull what its delegation allows this
  period. Even a fully compromised agent key cannot take more than the allowance.
- **Nothing signs without the policy.** Tools return unsigned transactions and a tool-written
  intent. The policy signer then checks the transaction:
  - it decodes every instruction;
  - it checks programs and destinations;
  - it values the transaction at the larger of the declared and decoded amounts;
  - it strips any signer a tool embedded in the message.

  Model output never reaches a signer.
- **Approvals are verified twice.** The owner signs a message that names the draft's hash
  and a USD bound. The server and the runtime both verify that signature before executing. If the rebuilt transaction
  comes out more than 10% above the approved USD value, the draft goes stale instead.
- **Keys:** local agent keys are encrypted files. Hosted keys are encrypted with a server secret
  and never leave the server. Removing an agent archives its key instead of deleting it.
- **Prompt injection:** the demo agent `pool-scout` reads a poisoned pool description telling it
  to send its USDC to an attacker. The model obeys; the policy blocks the transfer (the
  destination isn't allowed); the feed and Telegram show **BLOCKED**. See
  `fixtures/injection/`.
- **Mainnet is opt-in.** Every command defaults to devnet; `--mainnet` asks for confirmation.

## Status and roadmap

v0.1.0 (hackathon build): everything above works on devnet and on a Surfpool mainnet fork
(for Jupiter swaps). The recorded demo runs on mainnet with a few dollars.

Next:
- a cloud deployment of the hosted runtime (today it runs on the owner's machine behind a
  tunnel);
- managed key custody for hosted agents (MPC or TEE);
- Swig smart-wallet rules onchain, layered on the offchain policy signer (the spike passed);
- agents paying for data APIs from their allowance via x402;
- third-party tools loaded at runtime;
- more wallets for owners.

## Development

```bash
pnpm typecheck && pnpm lint && pnpm test   # fork tests run when Surfpool is up on :8899
pnpm docs:manifest                          # regenerate docs/manifest-spec.md
```

Surfpool fork for swap tests:
`surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"`.
