# syndromí architecture

Status: Day-1 decisions, backed by the spikes in `scripts/`. Updated 2026-09-29.

## Components

```
                ┌──────────────── owner (Phantom) ────────────────┐
                │ signs: init authority, grant/revoke delegations, │
                │ approve drafts & top-ups (Blinks)                │
                └──────────────┬───────────────────────────────────┘
                               │ Subscriptions Delegation Program
   bag = owner's USDC ATA ─────┤  De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
                               │  recurring delegation = allowance
                               │  fixed delegation     = approved top-up
                               ▼  revokeDelegation     = kill switch
   agent wallet (keypair) ◄── pull (agent signs transferRecurring / transferFixed)
        │
        │  runtime: LLM → tools → unsigned tx
        ▼
   policy signer (packages/core) ── allow ──► sign & send
        │ needs_approval ──► draft → Telegram/dashboard Blink → owner signs
        └ block ──► BLOCKED in activity feed + Telegram alert
```

## Decisions

### 1. Allowances: Subscriptions Delegation Program (confirmed)

`scripts/spike-delegation.ts` runs on devnet with a fresh 6-decimal test mint and agent keypair.
It passes 16/16 steps with `--wait-reset`:

| Step | Result |
|---|---|
| Owner funds agent fee budget (0.02 SOL); agent creates its own token account | ok |
| `initSubscriptionAuthority` once per (owner, mint) | ok |
| `createRecurringDelegation` 10 tUSDC / 60 s, `startTs = 0`, expiry +1 day | ok |
| Agent pulls 6 → ok; 6 more → **program error 400** "Transfer amount exceeds period limit" | ok |
| After 65 s the period resets; agent pulls 6 again | ok |
| `revokeDelegation`, then a pull → fails (delegation PDA closed: "Invalid account owner") | ok |
| `createFixedDelegation` 5 tUSDC; pull 3 → ok; 3 more → **program error 300** "exceeds delegation limit" | ok |

Example devnet transactions: [recurring grant](https://explorer.solana.com/tx/3QEv6kxJn9VUA4ak65Uhns2q7bYSY8s4J9WphJVcEY59t6mVugSuYc6qE6DpccghPJrQuEucXtCEeBWhoAMNGA74?cluster=devnet),
[agent pull](https://explorer.solana.com/tx/4HeFT7bnqAh4vfAnHo1TEcfqQiVZJQmyDNT33Lk4LUbRpDU9TVvc9VPRVqqGP6WUM178Fih5qgHNUxmD3X5pxhbe?cluster=devnet),
[revoke](https://explorer.solana.com/tx/5MLyrbQ4vAchwiq3sYcCoVKeaa87TLuY1T8pQbU4LWHyhKq4XnRSBkbH7ZNm8AY4UgKgXbWZfwqJtZATSPgqmQM6?cluster=devnet).

Notes for `packages/core`:
- `@solana/subscriptions@0.5.0` peers on **`@solana/kit` ^7**, so the repo pins the kit 7 line
  (`kit-plugin-rpc` 0.15, `kit-plugin-signer` 0.13, `@solana-program/token` 0.15, `system` 0.13,
  `compute-budget` 0.17). Don't upgrade to kit 8 until subscriptions does.
- The plugin API (`client.subscriptions.instructions.*().sendTransaction()`) matches the docs.
  Owner signs setup and revoke; the delegatee signs pulls and pays their fee.
- Delegation PDAs are keyed by (authority, delegator, delegatee, **nonce**). Use nonce 0 for the
  allowance and a fresh nonce per top-up.
- Kill switch: `revokeDelegation` per delegation, plus `revokeSubscriptionAuthority` to clear the
  token-account approval entirely (not exercised yet).
- Token-2022: the docs overview now says TransferHook mints are supported, but the SDK still
  defines `MINT_HAS_TRANSFER_HOOK`. Irrelevant for us: we use plain SPL mints.

### 2. Swaps: Jupiter Swap API v2 `/build`, tested on a Surfpool mainnet fork (confirmed)

`scripts/spike-jupiter.ts` fetches `GET https://api.jup.ag/swap/v2/build`, converts the raw
instructions to kit instructions, and builds an **unsigned** v0 transaction:
- fork blockhash;
- Jupiter's lookup tables;
- a compute-unit limit of 1.2× the simulated usage.

Only then does it sign. That's the exact shape the `jupiter-swap` tool will use. We don't use
`/order` + `/execute`, because Jupiter lands that transaction itself, which bypasses the policy
signer.

Result: 10 USDC → SOL executes on the fork. USDC drops by exactly 10, and SOL rises within about
0.3% of the quote (≈53k CU).

Findings:
- **Keyless access works** (low rate limit). `JUPITER_API_KEY` is optional and sent as `x-api-key`.
- **Prop AMMs don't work on a fork.** Jupiter's default routes often go through oracle-priced
  AMMs (SolFi V2, ZeroFi, BisonFi). Their state goes stale on a fork and the swap reverts. On the
  fork we pass `dexes=Whirlpool,Raydium CLMM` (Raydium CLMM, Whirlpool, DefiTuna and Invariant
  each worked alone). Mainnet uses default routing.
- **Intermittent fork failures.** About 1 in 5 swaps fails on the fork. The likely cause is that
  Surfpool caches pool accounts on first fetch while quotes are live. Kit's preflight error
  parsing also choked on Surfpool's response (`Cannot destructure property 'err'`), so
  `lib/surfpool.ts` simulates first, then sends with `skipPreflight` and polls over HTTP. Retry
  once in dev; this is not a mainnet concern.
- Start the fork with:
  `surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"`

### 3. Onchain outflow rules: Swig (spike passed; adoption is a scope call, see below)

`scripts/spike-swig.ts` runs on the fork against the real Swig program
(`swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB`). It passes 14/14 steps:

| Role | Test | Result |
|---|---|---|
| agent: token program + `tokenDestinationLimit` 5 USDC → own ATA | send 3 USDC to self | ok (398-byte tx) |
| | send 1 USDC to unknown address | **blocked**, Swig error 3006 |
| | send 3 more to self (over cap) | **blocked**, Swig error 3031 |
| swapper: Jupiter + token + ATA programs, `tokenLimit` 5 USDC | Jupiter swap 2 USDC → SOL signed through Swig, Swig wallet PDA as taker | ok (734-byte tx, balances verified) |
| | swap 4 more (over cap) | **blocked**, Swig error 3011 |
| | send 1 USDC to unknown address | **allowed**: the gap |
| strict: Jupiter + ATA programs only, `tokenLimit` 5 USDC | Jupiter swap with the cleanup instruction dropped | ok |
| | send 1 USDC to unknown address | **blocked**, Swig error 3006 |

What this means:
- Swig can enforce "spend at most X, only via Jupiter" onchain. `destinations: [self]` can't be
  expressed as a Swig destination limit for swaps, because swap outflows go to pool vaults.
  Program allowlist plus amount cap is the right shape.
- **Don't allowlist the token program** for a swapping role. It turns the role into "send up to
  the cap to anyone". Jupiter only needs it for the wSOL cleanup (`closeAccount`). For
  USDC → LST swaps (the yield-scout demo) there is no wSOL to clean up anyway.
- Costs if adopted:
  - agent funds live in the **Swig wallet PDA**, not the agent keypair, so allowance pulls
    must land in the Swig wallet's ATA;
  - creating an agent needs one more owner-signed transaction (create the Swig and add the role);
  - `@swig-wallet/kit@2.1.0` is built on `@solana/kit` 2, so we cast at the boundary;
  - its ESM build doesn't re-export `@swig-wallet/lib` (import `Actions` from the lib directly).

**Recommendation:** keep the **offchain policy signer as the primary gate**. It's required anyway
for USD caps (Pyth), the approval threshold and drafts, and it produces the BLOCKED feed event
for the injection demo. Add Swig as a second, onchain layer only if Days 2–3 finish on time;
it's now a proven first stretch item, not a research risk. The pitch line it enables is: "even a
compromised agent host can only swap via Jupiter, within its cap."

## `packages/core` (Day 2)

| Module | What it does |
|---|---|
| `policy.ts` | `evaluate(proposal, policy, prices)` → `allow / needs_approval / block` with every reason; `createPolicySigner` wraps the agent key and signs only `allow` (or `needs_approval` with an approved draft id). |
| `bag.ts` | Owner: `ensureSubscriptionAuthority`, `grantAllowance`, `grantTopUp`, `revoke`, `revokeAll({ agent?, hard? })`. Agent: `pullAllowance`, `pullTopUp`. Reads: `listDelegations` with remaining-this-period. Writes return plain instructions (CLI sends them; dashboard hands them to Phantom). |
| `manifest.ts` | zod schema + `parseManifest` (one readable line per error) + `toPolicy`. |
| `agent-wallet.ts` | scrypt + AES-256-GCM encrypted keypairs under `~/.syndromi/agents/<name>/`, or `SYNDROMI_AGENT_KEY_<NAME>` for hosted agents. |
| `prices.ts` | `PriceSource`: keyless Jupiter Price API v3 by default, Pyth Hermes when `PYTH_API_KEY` is set. |
| `tokens.ts`, `programs.ts` | Pinned mints (verified) and manifest program names → program IDs. |

Policy checks, in order:
1. The agent must be the fee payer.
2. Every top-level program must be allowlisted (compute-budget is always allowed).
3. Token, system, ATA and subscriptions instructions are decoded:
   - `Approve` and `SetAuthority` always block;
   - transfers, closes, SOL sends, ATA creation and allowance pulls must go to an allowed owner.

   So allowlisting the token program (which Jupiter needs) never means "send anywhere". This
   closes offchain the same gap the Swig spike found onchain.
4. The USD value is the larger of the tool-declared intent and the decoded outflows. Above
   `max_tx_usd` blocks; above `approve_above_usd`, or with any unpriced asset, needs approval.

Known limits:
- Value moved *inside* a Jupiter CPI is taken from the tool-built intent (Jupiter's `inAmount`).
- Simulation-based balance diffs are Day-6 hardening.

Gotchas found on Day 2:
- **Subscription Authority first.** `createRecurringDelegation` / `createFixedDelegation` read
  the authority's init id while building the instruction. The authority can't be created in the
  same transaction, so the first grant per (owner, mint) takes two transactions.
- **Delegation accounts don't store their nonce.** `grantTopUp` finds the next free nonce by
  deriving PDAs from 1 upward.
- **Surfpool can't reliably create new mints.** `createMint` hung for about 30 s and failed with
  kit's opaque `Cannot destructure property 'err'` error. Fork tests use mainnet USDC funded by
  `surfnet_setTokenAccount`; devnet (`pnpm demo:core`) creates a fresh mint without trouble.

## Local dev

- `pnpm spike:delegation [--wait-reset]` runs on devnet and uses the Solana CLI wallet as owner
  (override with `OWNER_KEYPAIR`).
- `pnpm spike:jupiter [--dexes=<labels>|all]` and `pnpm spike:swig` need Surfpool running (see above).
- `pnpm demo:core` runs on devnet: create agent → grant → pull → list → revoke, using only `@syndromi/core`.
- `pnpm test` runs all unit tests; the bag's fork test runs only when Surfpool is up on :8899.
