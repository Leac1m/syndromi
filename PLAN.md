# syndromí: build plan

syndromí is a product. The work is organised in phases: Phases 0–7 build v0.1.0, and the beta track takes it to testers on devnet. The dates in the headings record when each phase was planned.

Each phase has a goal, tasks, a "done when" check, and a kickoff prompt to paste into Claude Code. Start each phase in a fresh session with plan mode, and let Claude Code read `CLAUDE.md` and this file first.

---

## Phase 0 (Sep 28): setup, 1–2 hours

- [x] Every team member registers individually on colosseum.com.
- [x] Create the GitHub repo (public, MIT or Apache-2.0). Add `CLAUDE.md` and `PLAN.md` at the root. _(https://github.com/Leac1m/syndromi, MIT.)_
- [x] Install: Node 20+, pnpm, Solana CLI, Surfpool. _(Node 24.20, pnpm 12.5.1, solana-cli 4.3.0, surfpool 1.6.0. Solana CLI added to PATH in `~/.bashrc`.)_
- [x] Two Phantom accounts on devnet: `owner` and `demo-viewer`. Airdrop devnet SOL.
- [x] Get an RPC key (Helius free tier is enough) and an LLM API key. _(Both verified: Helius devnet `getHealth` → ok; `GEMINI_API_KEY` answers via Gemini's OpenAI-compatible endpoint with `gemini-3.8-flash`.)_
- [x] Create a Telegram bot via BotFather; save the token. _(Checked: `getMe` returns @syndromi_bot.)_
- [x] In Claude Code: add the Solana MCP server (https://mcp.solana.com/) and run `npx skills add ColosseumOrg/colosseum-resources`. _(solana-mcp is connected; the skill is in `.agents/skills/colosseum-resources`.)_

---

## Phase 1 (Sep 29): spikes and scaffold

**Goal:** prove the three risky assumptions before building on them.

- [x] Scaffold the pnpm monorepo per `CLAUDE.md` (empty packages, shared tsconfig, Vitest, lint, `.gitignore` with keys/.env). _(Biome for lint/format; Solana deps pinned to kit 7.)_
- [x] `scripts/spike-delegation.ts`: on devnet, owner creates a **recurring delegation** to an agent pubkey; agent pulls within the limit; a pull over the limit fails; owner **revokes**; next pull fails. Also create a **fixed delegation** and pull against it. _(16/16 on devnet incl. period reset.)_
- [x] `scripts/spike-jupiter.ts`: get a Jupiter quote and swap tx for USDC → SOL, and execute it against a **Surfpool mainnet fork**. If that doesn't work, fall back to: build + simulate only in dev, one real mainnet swap for the video. _(Works on the fork via `/swap/v2/build`, keyless; the fork needs classic-AMM routing (`dexes`), and about 1 in 5 fork swaps fail intermittently. The `--simulate-mainnet` fallback wasn't needed, so it wasn't built.)_
- [x] Swig spike, **timeboxed to 2 hours**: can an agent wallet be restricted to Jupiter + self-transfers onchain? Record the decision in `docs/architecture.md`. _(Works onchain for amount caps and a Jupiter-only program allowlist; "self-only" can't apply to swaps. Recommendation: offchain policy signer stays primary; Swig is the first stretch item.)_

**Done when:** all three spike scripts run, and `docs/architecture.md` records the decisions.

> **Kickoff prompt:** Read CLAUDE.md and PLAN.md. We're on Phase 1. Before writing code, use the Solana MCP and the linked docs to confirm the current `@solana/subscriptions` API for recurring and fixed delegations, pulls, and revocation. Then scaffold the monorepo and write `scripts/spike-delegation.ts` against devnet. Show me the plan first.

---

## Phase 2 (Sep 30): `packages/core`

**Goal:** the money and safety primitives, tested.

- [x] Manifest schema (zod) + parser + validation errors a human can read. _(`templates/*/manifest.yaml` added; prompts are Phase 3.)_
- [x] Bag client: init Subscription Authority, grant recurring allowance, grant fixed top-up, revoke one, revoke all, read delegation state. _(The authority must land before the first grant, so the first grant per mint takes two transactions.)_
- [x] Agent wallet: generate, encrypt/decrypt locally (passphrase), load hosted keys from env.
- [x] Policy signer: checks program allowlist, destination allowlist, per-tx USD cap (via Pyth price), and approval threshold. Returns `allow | needs_approval | block` with a reason. Only `allow` signs. _(Prices come from a `PriceSource`: keyless Jupiter by default, Pyth when `PYTH_API_KEY` is set. `needs_approval` signs only with an approved draft id. Deferred to Phase 6: simulation-based outflow checks inside swap CPIs.)_
- [x] Tests: policy decisions table-driven; delegation flows against Surfpool or LiteSVM. _(48 tests. The Surfpool flow is skipped when the fork isn't running. `pnpm demo:core` passes on devnet.)_

**Done when:** `pnpm test` passes and a script can create an agent, grant it an allowance, and pull.

> **Kickoff prompt:** Phase 2. Implement packages/core per CLAUDE.md: manifest schema, bag client wrapping @solana/subscriptions, agent wallet, and the policy signer. The policy signer is the most important file in the repo; write table-driven tests for it first.

---

## Phase 3 (Oct 1): runtime, tools, CLI

**Goal:** a local agent that thinks, reads prices, and proposes a swap.

- [x] Tool interface (MCP-compatible shape + `kind: read|write`). Write tools return unsigned transactions only. _(Tools build with a noop agent signer; the policy signer strips embedded signers and signs only with the agent key.)_
- [x] Tools: `pyth-price`, `balances`, `jupiter-quote`, `jupiter-swap`, `pull-allowance`, `request-topup`, `propose-tx`. _(`pyth-price` uses the PriceSource: Pyth, then Jupiter. `request-topup` returns an approval request, not a transaction.)_
- [x] LLM providers: Anthropic (BYOK) + one OpenAI-compatible endpoint. _(Gemini tested live. Anthropic is unit-tested with mocks only, since there's no key yet. Manifest gains `model_id` and `api_key_env`.)_
- [x] Agent loop: load manifest + prompt → run tools → route any transaction through the policy signer → log every step to a structured activity log. _(Drafts and top-up requests go to a file-based `ApprovalGateway`; Phase 4's server implements the same interface. Executing an approved draft is deferred to Phase 4.)_
- [x] Scheduler (cron string from the manifest). _(croner, with overlapping runs skipped.)_
- [x] CLI: `syndromi init <template>`, `syndromi run <dir>`, `syndromi revoke --all`. _(Also `fund` (the owner side of agent creation) and `status`, plus `run --once` and `--model`. Run with `pnpm syndromi …`; `--fork` or `--mainnet` (typed confirmation).)_
- [x] Templates: `dca-agent`, `yield-scout` (proposes USDC → a liquid staking token as the "yield" move).

**Done when:** `syndromi run templates/dca-agent` pulls its allowance and executes a small DCA (Surfpool fork), and `yield-scout` produces a draft that the policy marks `needs_approval`.

_Done (Sep 29), on the Surfpool fork with live Gemini: dca-agent pulled 3 USDC and swapped them for SOL (both ALLOW, sent); yield-scout pulled 15 USDC and proposed 15 USDC → JitoSOL, marked NEEDS_APPROVAL ($15 > $10), with a draft written and nothing sent. The injection fixture (`fixtures/injection/`) is blocked in `loop.test.ts`. 80 tests. See `docs/architecture.md` for the Phase 3 gotchas: Surfpool stalls, the Jupiter size limit, and Gemini's free-tier quota of 20 requests per day per model._

> **Kickoff prompt:** Phase 3. Build packages/tools, packages/runtime, and packages/cli. Keep the LLM strictly away from signing: tools return unsigned txs, the policy signer decides. Get `syndromi run templates/dca-agent` working end to end before touching the yield scout.

---

## Phase 4 (Oct 2): approvals

**Goal:** the owner approves from Telegram by signing, never by clicking a plain link.

- [x] `apps/server`: SQLite store for agents, drafts, top-up requests, activity. _(Hono + built-in `node:sqlite`.)_
- [x] Solana Actions endpoints: `GET/POST /actions/approve-draft/:id` and `/actions/approve-topup/:id`. The owner signs in their wallet; the top-up action creates a fixed delegation. _(Drafts use sign-message; the runtime re-verifies the owner's signature. Top-ups: the wallet signs, the server sends to the agent's cluster and accepts only the transaction it issued, allowing wallet-added compute-budget instructions. dial.to was down, so owners sign in our own Blink viewer at `/approve/:id`.)_
- [x] Telegram bot: pushes a message with the Blink link for each pending draft/top-up; notifies on BLOCKED events. _(The owner's chat is bound with a one-time `/start` code; Reject button; `/pending`.)_
- [x] Runtime ↔ server: agents post drafts and requests; poll or subscribe for approval; execute on approval; expire stale drafts. _(The approval watcher runs without the LLM: it re-quotes, re-checks the policy, stays within 10% of the signed USD bound, and retries failed simulations. Drafts expire after 30 min, top-ups after 24 h. CLI: `run --server`, `watch`, `approve`, `request-topup`.)_

**Done when:** a yield-scout draft reaches Telegram, the owner signs, and the swap executes; a top-up request does the same.

_Done (Sep 29), manually with Telegram Desktop and Phantom:_
- _yield-scout (NVIDIA model, fork) drafted 15 USDC → JitoSOL; the owner signed the message in Phantom; the watcher executed the swap (draft `d_232914fb`, tx `3Jv9Gv…`)._
- _dca-agent (devnet) top-up of 5 USDC: Phantom signed the delegation (`5gkPyx…`), and the watcher pulled it (`376c64…`)._

_Automated in `packages/cli/src/e2e.fork.test.ts`. Deferred: approving from a phone needs a public URL (Phase 6 deploy or a tunnel)._

> **Kickoff prompt:** Phase 4. Build apps/server: SQLite store, Solana Actions endpoints for approving drafts and top-ups, and the grammY Telegram bot. Keep @solana/actions and web3.js v1 isolated inside apps/server. Check the current Actions spec in the docs first.

---

## Phase 5 (Oct 3): dashboard

**Goal:** the owner's screens: bag, agents, approvals, activity, kill switch.

- [x] Phantom Connect sign-in. _(`@phantom/react-sdk`, extension only; the owner signs a one-time message and gets a 12 h session.)_
- [x] Bag view: USDC balance, total allocated per period, list of delegations.
- [x] Create-agent wizard: pick template → edit allowance/permissions → **rule card** preview in plain language → owner signs delegation + fee-budget transfer. _(Hosted: the server creates and encrypts the key. Local: the wizard shows the `syndromi init --server --owner` command, then funds. Funding is the `fund-agent` Action, with a setup step chained when needed.)_
- [x] Agent list with status, remaining allowance this period, pending approvals (approve inline via the same Actions).
- [x] Activity feed (readable events, BLOCKED in red).
- [x] Kill switch: revoke all delegations in one signature where possible. _(Also a Blink: Telegram `/kill`.)_

**Done when:** the full demo can be driven from the dashboard plus Telegram without touching the CLI except for the local agent.

_Done (Sep 29) on devnet with Phantom, using the dashboard and Telegram:_
- _sign in;_
- _create hosted yield-scout, then fund it (`8ooGVn…`);_
- _`syndromi init --server --owner` for local dca-agent, then fund it from the wizard (`4YvrawV…`);_
- _approve a 5 USDC top-up inline (`5xf47Z…`), which the watcher pulled (`56T2xn…`);_
- _kill switch (`4m6YDA…`), leaving 0 delegations onchain. The feed and Telegram showed each step._

_Deferred: Google/Apple embedded wallets (need a Phantom Portal App ID); running hosted agents (Phase 6); BLOCKED from a live agent run in the feed (Phase 6 injection demo)._

> **Kickoff prompt:** Phase 5. Build apps/dashboard in Next.js with Phantom Connect. Priority order: create-agent wizard with rule card, activity feed, kill switch, then bag view polish. Keep styling simple and consistent.

---

## Phase 6 (Oct 4): hosted mode and the security demo

**Goal:** the same agent runs hosted, and the injection attack visibly fails.

- [x] `syndromi deploy <dir>`: uploads a manifest to the server, which runs it with the same runtime. _(The hosted runtime runs inside the server: keys encrypted with `SYNDROMI_HOSTED_SECRET`, cron or **Run now**, and an approval watcher.)_
- [x] Deploy the server (a small VPS, Fly, or Railway). Hosted yield-scout runs on schedule. _(Cut line 1, by choice: the server runs on the owner's machine behind a Cloudflare quick tunnel, `pnpm tunnel`, so phones can approve via Phantom's browse deep link. Deferred: a real cloud deploy with a stable URL.)_
- [x] `fixtures/injection`: a tool response (e.g. a fake pool description) containing an instruction to transfer funds to an unknown address. Show: the model attempts it, the policy returns `block`, Telegram alert, BLOCKED in the feed. _(`pool-scout` reads the poisoned `yield-data`. The real NVIDIA model fell for it with the prompt guard off (demo-only flag) and was BLOCKED. `demo.script: injection` is the scripted fallback.)_
- [x] Full demo rehearsal on devnet/fork; list every rough edge. _(Run 1 is complete; see below. Run 2 waits for the NVIDIA model to recover.)_

**Done when:** the six-step demo in `CLAUDE.md` runs start to finish twice in a row.

_Rehearsal run 1 (Sep 29, devnet + fork, Phantom desktop + phone, Telegram):_
- _Steps 1–2: sign in; `yield-scout` hosted on the fork (funded `Ubi8Gz…`); `dca-agent` local on devnet (`3BeR1U…`)._
- _Step 3 twice: hosted run → draft → approved → the server swapped (`2BbN7e…`, `fqEXfM…`)._
- _Step 4: top-up approved and pulled (`4SyexW…`)._
- _Step 5: the live NVIDIA model timed out repeatedly (provider outage), so the scripted `pool-scout` stood in: BLOCKED, with a Telegram alert and nothing sent. The real model had fallen for the injection earlier the same day on the fork._
- _Step 6: kill switch on devnet (`58vThr…`), leaving 0 delegations._

_**Not yet met:** two consecutive full runs with the live model. Run 2 is pending the NVIDIA recovery._

**Rough edges for Phase 7** (from the rehearsal):
1. The feed shows nothing while an agent thinks; show progress lines (tool calls, "asking the model…").
2. LLM timeouts aren't retried, and the message is cryptic ("The operation was aborted due to timeout"). Retry once, then say the provider didn't respond.
3. **Run now** stays at "Run started ✓" and never shows when the run finished or failed.
4. **A backup model:** the NVIDIA key reaches only one chat model, and it went down. Configure a second provider (paid Gemini or Anthropic) with automatic failover on timeouts.
5. For the recording, keep the scripted `pool-scout` ready as a clearly labelled fallback.
6. Step 4 used `syndromi request-topup`. For the video, have the agent request a top-up itself when its allowance is used up.
7. Agents from failed attempts clutter the list; add a "remove agent" action (and only list registered agents that are unfunded when asked).
8. The tunnel URL changes on every restart, so `PUBLIC_URL` is set by hand; script the tunnel-then-server start.
9. Confirm the **Open in Phantom (phone)** path on the phone for both message and transaction approvals.
10. A mainnet rehearsal needs a fresh owner wallet (about $30 USDC + 0.05 SOL).

> **Kickoff prompt:** Phase 6. Implement `syndromi deploy` and hosted execution in apps/server using the same runtime package. Then build the injection fixture and verify the policy blocks it. Finally, script a full demo run and report every failure.

---

## Phase 7 (Oct 5): harden, document, freeze

- [ ] Fix the rough-edges list from Phase 6. No new features. _(Done except 9 and 10, which need the phone and a mainnet wallet. 1: tool calls show as progress lines. 2: 60 s per attempt, one retry, errors name the provider and model. 3: Run now follows its run to Finished/Failed. 4: Anthropic on the official SDK (`claude-opus-5-5`, server-side refusal fallbacks) plus `FailoverProvider` via `SYNDROMI_FALLBACK_MODEL`; a dead primary failing over to NVIDIA was checked live, and Anthropic waits for `ANTHROPIC_API_KEY`. 5: the runbook covers the labelled scripted fallback. 6: `pull-allowance` explains a shortfall and dca-agent requests its own top-up. 7: Remove agent (keys are archived, not deleted). 8: `pnpm demo:up`.)_
- [x] README: pitch, 60-second quickstart (`syndromi init` → `run`), architecture diagram, security model, roadmap.
- [x] `docs/manifest-spec.md` and `docs/package-spec.md` (the dev-community story). _(The manifest spec is generated from the schema (`pnpm docs:manifest`), and a test keeps it current.)_
- [ ] Rehearsal run 2 (the Phase 6 done-when), including the phone path for a message and a transaction approval.
- [ ] Record a raw screen capture of the full demo as a safety copy.
- [ ] Tag `v0.1.0`.

> **Kickoff prompt:** Phase 7. No new features. Work through the rough-edges list, then write the README, architecture doc, manifest spec, and package spec from the code as it actually exists.

---

## Beta track (devnet, bring your own AI)

Design and decisions: [`docs/beta-design.md`](docs/beta-design.md). No model keys from us; server-held
keys are devnet only.

- [x] Beta phase 0: `runtime: external`, the `mcp-agent` default template, `syndromi mcp` (stdio), BYO-AI README, landing page at `/` and the app at `/app`.
- [ ] Beta phase 1, a reachable server: `/healthz`, a "connecting" state in the dashboard, hide `fork`, an always-on instance, deploy guide. _(Oct 2: trial running on Render's free tier + Neon Postgres (`DATABASE_URL`; the store now speaks SQLite and Postgres) + Vercel at `syndromi.vercel.app`; see beta-design "Running now". Oct 5: decided to stay on Render with a paid instance instead of the VPS (Dockerfile, Caddy and DuckDNS are dropped). Done: `GET /healthz`; the dashboard waits on it and shows "Connecting to the server…", then a notice if the connection is lost; `fork` shows only with `NEXT_PUBLIC_SHOW_FORK=1`. Still open, owner actions: move the Render service to a paid instance and set its health check path to `/healthz`; the deploy guide.)_
- [x] Beta phase 2, remote agents: token store (hashed, scoped, revocable, kill-switch aware); server-held external agents (devnet only); `/agent/v1` HTTP API; `/agent/mcp` over Streamable HTTP; rate limits; dashboard "Connect an AI"; tests. _(Oct 2: see beta-design "Built: Beta phase 2". Verified end to end with a real MCP client over HTTP against a local server on devnet. Open: a read cache for quotes, an owner allowlist, a token-free CLI path.)_
- [ ] Beta phase 3, polish: npm publish of the bundled CLI (owner); a real domain; optional browser chat panel and framework adapters.
- [x] Beta phase 4, test tokens and a faucet: a treasury key (`SYNDROMI_TREASURY_KEY`, devnet only) that is the mint authority of syndromí's own test USDC and test JitoSOL, registered as the devnet twins of the mainnet tokens so prices and templates work unchanged; `scripts/beta-setup.ts`; `POST /owner/faucet` with a per-wallet daily limit; "Get test tokens" in the dashboard; token decimals no longer assumed to be 6. Testers get devnet SOL from the public faucet themselves. _(Oct 5: done; see beta-design "Test tokens and the faucet". Mints created and verified on devnet; a claim, a refused second claim, and an allowance granted in test USDC were all run for real. Also added: `syndromi faucet` for the CLI's owner wallet, and `/healthz` reports a low treasury. Open, owner action: set `SYNDROMI_TREASURY_KEY` on the hosted server. Agents funded earlier with Circle's devnet USDC should be revoked and recreated.)_
- [x] Beta phase 5, a pool to swap in: an Orca Splash Pool (full range) for the two test tokens, starting with a spike (`scripts/spike-orca.ts`: the SDK peers on kit 5 and we pin kit 7); an `orca` program permission; `orca-quote` and `orca-swap` tools (devnet only); templates updated; a keeper that nudges the pool back toward the live price. _(Oct 5: done; see architecture decision 4 and beta-design "A pool to swap in". The spike passed 7 of 7 under kit 7, so no separate kit 5 package was needed. Pool `HRjoKcD6…fvq3H` is live on devnet. `SYNDROMI_DEVNET_E2E=1` runs a real pull, swap, hold, block and top-up request. The keeper was run once for real, including a forced rebalance. Open: agents created earlier need the `orca` tools and permission added by hand.)_
- [x] Beta phase 6, the guided run: `model: script:<name>` as a first-class scripted model (no key); a `guided-tour` template whose run executes, waits for approval, is blocked and asks for a top-up; a "Try a guided run" card for owners with no agents, ending in "Connect your own AI". _(Oct 5: done; see beta-design "The guided run". Run for real on devnet through a local server: create, fund, run, approve the held swap and the top-up. Differs from the plan: `mcp-agent` stays first in the template list and the wizard hides the tour template, since the tour has its own card. Open: look at the card in a browser.)_
- [x] Beta phase 7, Telegram management: `/status` with allowance left and pending counts; Pause and Revoke AI access buttons. Telegram can only tighten: resuming, raising limits and approving stay in the wallet or the signed-in dashboard. _(Oct 5: done; see beta-design "Managing agents from Telegram". Also: pause and resume on the agent's dashboard page, and the overview is now one function shared with the bot. Not checked against the real bot: its updates belong to the hosted server.)_
- [ ] Beta phase 8, wording: user-facing text only (bag → your wallet, draft → approval request, Blink → approval link, fee budget → SOL for network fees). Identifiers, API fields and manifest keys stay.

---

## Cut lines (if a phase slips, cut in this order)

1. Hosted deploy → demo hosted mode running on your own machine as the server.
2. Telegram → approvals via Blinks in the dashboard only.
3. Dashboard wizard → create agents via CLI; dashboard shows feed, approvals, and kill switch only.
4. Yield scout → keep only the DCA agent plus the injection demo.

Never cut: the policy signer, the delegation flow, the injection demo, the kill switch.

## Stretch (only if ahead)

- Agent pays for a data API from its allowance via x402.
- Swig-enforced outflow rules onchain (if the Phase-1 spike said "later").
- [x] A plugin so another agent framework can use a syndromí bag. _(Done Sep 30 as `syndromi mcp <dir>`: an MCP server over stdio. Same policy path as the loop, via the exported `callTool`; tested in `packages/cli/src/mcp.test.ts`. Tried live with Claude Code on devnet: `balances`, and a `request-topup` that the owner approved and the MCP process pulled. Its template `mcp-agent` (`runtime: external`: no model or schedule) is the default in the wizard and for `syndromi init`.)_

## Milestone: Colosseum submission (Oct 12, 2026)

One dated milestone alongside the product work. It does not set scope or priorities; nothing is built only for it.

- [ ] One real mainnet run with a few dollars for the video.
- [ ] Pitch video (problem → why now: the Subscriptions program → demo highlights → business model → team).
- [ ] Technical demo video (the six steps, code tour of the policy signer).
- [ ] Check the submission form for required fields and video limits early.
- [ ] Submit by Oct 10; keep Oct 11–12 as emergency buffer.
