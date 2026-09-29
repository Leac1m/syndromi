# syndromí: 7-day build plan

Development: **Tue Sep 29 → Mon Oct 5.** Code freeze end of Day 7.
Buffer: **Oct 6 → 12** for fixes, the mainnet demo run, videos, and submission. Aim to submit by **Oct 10**.

Each day has a goal, tasks, a "done when" check, and a kickoff prompt to paste into Claude Code. Start each day in a fresh session with plan mode, and let Claude Code read `CLAUDE.md` and this file first.

---

## Day 0 (today, Sep 28): setup, 1–2 hours

- [x] Every team member registers individually on colosseum.com.
- [x] Create the GitHub repo (public, MIT or Apache-2.0). Add `CLAUDE.md` and `PLAN.md` at the root. _(https://github.com/Leac1m/syndromi, MIT.)_
- [x] Install: Node 20+, pnpm, Solana CLI, Surfpool. _(Node 24.20, pnpm 12.5.1, solana-cli 4.3.0, surfpool 1.6.0. Solana CLI added to PATH in `~/.bashrc`.)_
- [x] Two Phantom accounts on devnet: `owner` and `demo-viewer`. Airdrop devnet SOL.
- [x] Get an RPC key (Helius free tier is enough) and an LLM API key. _(Both verified: Helius devnet `getHealth` → ok; `GEMINI_API_KEY` answers via Gemini's OpenAI-compatible endpoint with `gemini-3.8-flash`.)_
- [x] Create a Telegram bot via BotFather; save the token. _(Checked: `getMe` returns @syndromi_bot.)_
- [x] In Claude Code: add the Solana MCP server (https://mcp.solana.com/) and run `npx skills add ColosseumOrg/colosseum-resources`. _(solana-mcp is connected; the skill is in `.agents/skills/colosseum-resources`.)_

---

## Day 1 (Sep 29): spikes and scaffold

**Goal:** prove the three risky assumptions before building on them.

- [x] Scaffold the pnpm monorepo per `CLAUDE.md` (empty packages, shared tsconfig, Vitest, lint, `.gitignore` with keys/.env). _(Biome for lint/format; Solana deps pinned to kit 7.)_
- [x] `scripts/spike-delegation.ts`: on devnet, owner creates a **recurring delegation** to an agent pubkey; agent pulls within the limit; a pull over the limit fails; owner **revokes**; next pull fails. Also create a **fixed delegation** and pull against it. _(16/16 on devnet incl. period reset.)_
- [x] `scripts/spike-jupiter.ts`: get a Jupiter quote and swap tx for USDC → SOL, and execute it against a **Surfpool mainnet fork**. If that doesn't work, fall back to: build + simulate only in dev, one real mainnet swap for the video. _(Works on the fork via `/swap/v2/build`, keyless; the fork needs classic-AMM routing (`dexes`), and about 1 in 5 fork swaps fail intermittently. The `--simulate-mainnet` fallback wasn't needed, so it wasn't built.)_
- [x] Swig spike, **timeboxed to 2 hours**: can an agent wallet be restricted to Jupiter + self-transfers onchain? Record the decision in `docs/architecture.md`. _(Works onchain for amount caps and a Jupiter-only program allowlist; "self-only" can't apply to swaps. Recommendation: offchain policy signer stays primary; Swig is the first stretch item.)_

**Done when:** all three spike scripts run, and `docs/architecture.md` records the decisions.

> **Kickoff prompt:** Read CLAUDE.md and PLAN.md. We're on Day 1. Before writing code, use the Solana MCP and the linked docs to confirm the current `@solana/subscriptions` API for recurring and fixed delegations, pulls, and revocation. Then scaffold the monorepo and write `scripts/spike-delegation.ts` against devnet. Show me the plan first.

---

## Day 2 (Sep 30): `packages/core`

**Goal:** the money and safety primitives, tested.

- [x] Manifest schema (zod) + parser + validation errors a human can read. _(`templates/*/manifest.yaml` added; prompts are Day 3.)_
- [x] Bag client: init Subscription Authority, grant recurring allowance, grant fixed top-up, revoke one, revoke all, read delegation state. _(The authority must land before the first grant, so the first grant per mint takes two transactions.)_
- [x] Agent wallet: generate, encrypt/decrypt locally (passphrase), load hosted keys from env.
- [x] Policy signer: checks program allowlist, destination allowlist, per-tx USD cap (via Pyth price), and approval threshold. Returns `allow | needs_approval | block` with a reason. Only `allow` signs. _(Prices come from a `PriceSource`: keyless Jupiter by default, Pyth when `PYTH_API_KEY` is set. `needs_approval` signs only with an approved draft id. Deferred to Day 6: simulation-based outflow checks inside swap CPIs.)_
- [x] Tests: policy decisions table-driven; delegation flows against Surfpool or LiteSVM. _(48 tests. The Surfpool flow is skipped when the fork isn't running. `pnpm demo:core` passes on devnet.)_

**Done when:** `pnpm test` passes and a script can create an agent, grant it an allowance, and pull.

> **Kickoff prompt:** Day 2. Implement packages/core per CLAUDE.md: manifest schema, bag client wrapping @solana/subscriptions, agent wallet, and the policy signer. The policy signer is the most important file in the repo; write table-driven tests for it first.

---

## Day 3 (Oct 1): runtime, tools, CLI

**Goal:** a local agent that thinks, reads prices, and proposes a swap.

- [ ] Tool interface (MCP-compatible shape + `kind: read|write`). Write tools return unsigned transactions only.
- [ ] Tools: `pyth-price`, `balances`, `jupiter-quote`, `jupiter-swap`, `pull-allowance`, `request-topup`, `propose-tx`.
- [ ] LLM providers: Anthropic (BYOK) + one OpenAI-compatible endpoint.
- [ ] Agent loop: load manifest + prompt → run tools → route any transaction through the policy signer → log every step to a structured activity log.
- [ ] Scheduler (cron string from the manifest).
- [ ] CLI: `syndromi init <template>`, `syndromi run <dir>`, `syndromi revoke --all`.
- [ ] Templates: `dca-agent`, `yield-scout` (proposes USDC → a liquid staking token as the "yield" move).

**Done when:** `syndromi run templates/dca-agent` pulls its allowance and executes a small DCA (Surfpool fork), and `yield-scout` produces a draft that the policy marks `needs_approval`.

> **Kickoff prompt:** Day 3. Build packages/tools, packages/runtime, and packages/cli. Keep the LLM strictly away from signing: tools return unsigned txs, the policy signer decides. Get `syndromi run templates/dca-agent` working end to end before touching the yield scout.

---

## Day 4 (Oct 2): approvals

**Goal:** the owner approves from Telegram by signing, never by clicking a plain link.

- [ ] `apps/server`: SQLite store for agents, drafts, top-up requests, activity.
- [ ] Solana Actions endpoints: `GET/POST /actions/approve-draft/:id` and `/actions/approve-topup/:id`. The owner signs in their wallet; the top-up action creates a fixed delegation.
- [ ] Telegram bot: pushes a message with the Blink link for each pending draft/top-up; notifies on BLOCKED events.
- [ ] Runtime ↔ server: agents post drafts and requests; poll or subscribe for approval; execute on approval; expire stale drafts.

**Done when:** a yield-scout draft reaches Telegram, the owner signs, and the swap executes; a top-up request does the same.

> **Kickoff prompt:** Day 4. Build apps/server: SQLite store, Solana Actions endpoints for approving drafts and top-ups, and the grammY Telegram bot. Keep @solana/actions and web3.js v1 isolated inside apps/server. Check the current Actions spec in the docs first.

---

## Day 5 (Oct 3): dashboard

**Goal:** the screens that make the video look like a product.

- [ ] Phantom Connect sign-in.
- [ ] Bag view: USDC balance, total allocated per period, list of delegations.
- [ ] Create-agent wizard: pick template → edit allowance/permissions → **rule card** preview in plain language → owner signs delegation + fee-budget transfer.
- [ ] Agent list with status, remaining allowance this period, pending approvals (approve inline via the same Actions).
- [ ] Activity feed (readable events, BLOCKED in red).
- [ ] Kill switch: revoke all delegations in one signature where possible.

**Done when:** the full demo can be driven from the dashboard plus Telegram without touching the CLI except for the local agent.

> **Kickoff prompt:** Day 5. Build apps/dashboard in Next.js with Phantom Connect. Priority order: create-agent wizard with rule card, activity feed, kill switch, then bag view polish. Keep styling simple and consistent.

---

## Day 6 (Oct 4): hosted mode and the security demo

**Goal:** the same agent runs hosted, and the injection attack visibly fails.

- [ ] `syndromi deploy <dir>`: uploads a manifest to the server, which runs it with the same runtime.
- [ ] Deploy the server (a small VPS, Fly, or Railway). Hosted yield-scout runs on schedule.
- [ ] `fixtures/injection`: a tool response (e.g. a fake pool description) containing an instruction to transfer funds to an unknown address. Show: the model attempts it, the policy returns `block`, Telegram alert, BLOCKED in the feed.
- [ ] Full demo rehearsal on devnet/fork; list every rough edge.

**Done when:** the six-step demo in `CLAUDE.md` runs start to finish twice in a row.

> **Kickoff prompt:** Day 6. Implement `syndromi deploy` and hosted execution in apps/server using the same runtime package. Then build the injection fixture and verify the policy blocks it. Finally, script a full demo run and report every failure.

---

## Day 7 (Oct 5): harden, document, freeze

- [ ] Fix the rough-edges list from Day 6. No new features.
- [ ] README: pitch, 60-second quickstart (`syndromi init` → `run`), architecture diagram, security model, roadmap.
- [ ] `docs/manifest-spec.md` and `docs/package-spec.md` (the dev-community story).
- [ ] Record a raw screen capture of the full demo as a safety copy.
- [ ] Tag `v0.1.0`. **Code freeze.**

> **Kickoff prompt:** Day 7. No new features. Work through the rough-edges list, then write the README, architecture doc, manifest spec, and package spec from the code as it actually exists.

---

## Cut lines (if a day slips, cut in this order)

1. Hosted deploy → demo hosted mode running on your own machine as the server.
2. Telegram → approvals via Blinks in the dashboard only.
3. Dashboard wizard → create agents via CLI; dashboard shows feed, approvals, and kill switch only.
4. Yield scout → keep only the DCA agent plus the injection demo.

Never cut: the policy signer, the delegation flow, the injection demo, the kill switch.

## Stretch (only if ahead)

- Agent pays for a data API from its allowance via x402.
- Swig-enforced outflow rules onchain (if the Day-1 spike said "later").
- A plugin so another agent framework can use a syndromí bag.

## Oct 6–12: submission

- [ ] One real mainnet run with a few dollars for the video.
- [ ] Pitch video (problem → why now: the Subscriptions program → demo highlights → business model → team).
- [ ] Technical demo video (the six steps, code tour of the policy signer).
- [ ] Check the submission form for required fields and video limits early.
- [ ] Submit by Oct 10; keep Oct 11–12 as emergency buffer.
