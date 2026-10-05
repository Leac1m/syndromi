# Beta design: bring your own AI, remote agents, hosting

Status: written Oct 1, 2026. Beta phases 0 and 2 are built (Oct 2); see "Built: Beta phase 2" below for what
differs from the proposal. Beta phase 1 is partly live (Render + Neon + Vercel) and beta phase 3 is open.

The beta runs on Solana devnet. syndromí supplies **no model keys**: the brain is the tester's own.
This document covers how a tester connects that brain with no install, how we keep it safe, where
the server and dashboard run, and the order of work.

## Goals and non-goals

Goals
- A tester connects Claude, Cursor or any MCP client, or their own script or framework, in under
  two minutes, **with nothing to clone or install**.
- The same rules apply as everywhere else: every write passes the policy signer, approvals reach
  the owner, the kill switch stops everything.
- No provider keys on our server, no cost to us per tester action beyond RPC and price lookups.
- A stable public address for the test.

Non-goals (for the beta)
- Mainnet for remote agents. Server-held keys are devnet only.
- Storing testers' LLM keys.
- Running a tester's model loop on our server.
- A multi-region or highly available deployment.

## What exists

| Piece | Where | Note |
|---|---|---|
| `callTool` (tool → policy → send, draft or block) | `packages/runtime/src/loop.ts` | the one path to a signature |
| `buildMcpServer` + `syndromi mcp` (stdio) | `packages/cli/src/commands/mcp.ts` | needs the repo cloned and the key on the tester's machine |
| `runtime: external` + `mcp-agent` template | `packages/core/src/manifest.ts`, `templates/mcp-agent` | no model, no schedule |
| Server-held agent keys | `hosted_keys` table, encrypted with `SYNDROMI_HOSTED_SECRET` | used by hosted agents today |
| Hosted approval watcher | `apps/server/src/hosted.ts` | executes approved drafts and top-ups |
| Owner sign-in and sessions | `apps/server/src/sessions.ts` | wallet-signed message, 12 h token |
| MCP Streamable HTTP transport (web-standard, works with Hono) | `@modelcontextprotocol/sdk` 1.30.1 | stateless mode is supported |

## Design

### Two ways in, one implementation

A **remote agent** is an `external` agent whose key the server holds. Its owner can reach it with a
per-agent bearer token:

```
Authorization: Bearer syn_<token>

POST /agent/mcp                  MCP, Streamable HTTP (any MCP client)
GET  /agent/v1/me                the agent, its rule card, what is left of its allowance
GET  /agent/v1/tools             the tool list with JSON Schemas (what describe() already returns)
POST /agent/v1/tools/:name       { "input": { … } }  →  the same result text callTool returns
```

Both doors call `callTool` with the agent's loaded context. Nothing new decides anything:
HTTP 200 carries every policy outcome (`executed`, `awaiting_owner_approval`, `blocked`, …) in the
body, exactly as the MCP result does. HTTP errors are only for the protocol: 401 bad token, 404
unknown tool, 400 bad input, 429 rate limit.

The MCP endpoint is **stateless** (`sessionIdGenerator: undefined`): a fresh server and transport per
request, so there is no session state to lose on a restart and no sticky routing.

Custody has two modes for an `external` agent. This is a property of the agent record, not the
manifest, so the manifest stays portable:
- `local`: the key is on the tester's machine and they run `syndromi mcp` (stdio). Works today.
- `server`: the key is on our server, encrypted at rest. Remote MCP and the HTTP API work. This is
  the beta default, devnet only.

### Tokens

- Format `syn_` + 32 random bytes, base64url. Shown **once**, at creation.
- Stored as a SHA-256 hash plus an 8-character prefix for display. Never logged, never put in the
  activity feed, redacted in error text.
- Scope: one agent. Fields: id, agent, label, created, last used, expires, revoked. At most 3 live
  tokens per agent.
- Lifetime: **30 days by default**; the owner picks another from a fixed list when creating the
  token: 1 day, 7 days, 30 days, 90 days. There is no "never expires" option.
- The owner creates and revokes them from the dashboard, with the existing owner session
  (`POST/DELETE /owner/agents/:name/tokens`).
- Checked on every request (no cache), so revocation is immediate.
- The kill switch also disables every token of the owner's agents on that cluster, as part of its
  completion step, so one signature stops the delegations **and** the remote access.
- HTTPS only: with `NODE_ENV=production`, requests that did not arrive over TLS are rejected.

A leaked token can only do what the agent's policy allows: pull its allowance, and act within the
program and destination allowlist and the caps. It cannot sign anything outside the rules, and the
owner can revoke it at once.

### Server-held external agents

- Creation reuses `createHostedAgent`'s key handling, with the record marked `custody: server` and
  the manifest kept as `runtime: external`. The wizard's default for `mcp-agent` becomes
  "No install (we hold the key on devnet)", with "I hold the key (CLI)" as the alternative.
- `HostedRuntime` loads these agents **without** a provider and a schedule: it only needs the
  approval watcher, so an approved draft or top-up still executes without any client running.
- Devnet only for now: creating a server-held agent on mainnet or the fork is refused.
- The activity feed marks calls that came through a token (`via: mcp-http` or `via: http`, with the
  token's id prefix), so the owner can tell their own CLI from a connected AI.

### Abuse and cost controls

| Control | Value (start) |
|---|---|
| Per token | 60 calls/min, of which at most 10 writes/min |
| Per owner | 200 calls/min across their agents |
| Agents per owner | 5 |
| Request body | 64 KB |
| Tool call timeout | 30 s, then a clear error |
| Read caching | quotes and prices for a few seconds, to protect shared RPC and Jupiter limits |
| Response | 429 with `Retry-After` |

Limits are in-memory token buckets, enough for a single server process. MCP over HTTP also requires
validating the `Origin` header, so browser pages cannot drive a local or private server: accept
requests with no `Origin` (CLI clients) or one of `DASHBOARD_ORIGINS`.

### Threats

| Threat | Mitigation |
|---|---|
| Token leaked | scoped to one agent, policy still applies, revocable, expires, kill switch disables it |
| Tester's AI is prompt-injected | same policy signer blocks it: this is the product's point |
| Token brute force | 192+ bits of entropy; hash lookup; per-IP throttle on failures |
| Rate-limit evasion with many tokens | per-owner limit; at most 3 tokens per agent |
| Cost abuse of RPC and Jupiter | read caching, per-owner caps |
| Server compromise | encrypted keys need `SYNDROMI_HOSTED_SECRET`; devnet only in the beta; back the secret up separately |
| A rogue web page calls the endpoint | Origin validation; bearer token is not a cookie |

### Dashboard

On an external agent's page, a **Connect an AI** card:
- the token list, with **Create token** (shown once) and **Revoke**;
- ready-to-paste snippets for Claude Code, Cursor, a plain `curl` and a function-calling example.
  The exact client syntax must be checked against each client's current docs at build time (these
  tools change often), and nothing in the snippets is guessed.
A later, optional **chat panel** lets a tester paste a provider key that stays in their browser and
run the loop there against `/agent/v1`. It needs `/agent` CORS for the dashboard origins.

## Built: Beta phase 2 (Oct 2)

Tokens, server-held external agents, `/agent/v1`, `/agent/mcp`, the dashboard **Connect an AI** card and
tests are in. Where the build differs from, or adds to, the proposal above:

- **Tokens:** as designed (`syn_` + 32 random bytes, SHA-256 hash only, 3 live per agent, 1/7/30/90
  days, default 30, checked on every request, revoked by the owner, by removing the agent, and by the
  kill switch's completion step). The owner sees the prefix and last-used time; the secret is shown once.
- **Creation:** `POST /owner/agents` with `custody: "server"` (external templates only, devnet only);
  max 5 agents per owner. The wizard's default for an external agent on devnet is "No install".
- **Loading:** `HostedRuntime` loads these agents with no model and no schedule, so approved drafts and
  top-ups still execute with no client connected. `remote()` hands the doors the same tool context.
- **Doors:** both call `callTool` (MCP through the shared `buildMcpServer`, now in `packages/runtime`).
  MCP is stateless with plain JSON responses (no SSE), so nothing is lost on a restart.
- **Limits (defaults):** 60 calls/min and 10 writes/min per token, 200 calls/min per owner, 64 KB bodies,
  30 s per tool call (the answer says the call may still finish), 20 bad tokens/min per client address
  (the last `X-Forwarded-For` entry, the one the host's proxy adds). Calls to one agent run one at a
  time. Over the limit: 429 with `Retry-After` (over MCP, a write over the limit is a tool error).
- **Transport checks:** a request with an `Origin` outside `DASHBOARD_ORIGINS` is refused; with an https
  `PUBLIC_URL`, plain http is refused. No CORS is enabled on `/agent`, so browser pages cannot read it
  (the optional browser chat panel would need that).
- **Activity:** calls through a token are marked `via: mcp-http | http` with the token prefix; token
  creation and revocation appear in the feed.
- **Not done:** reading-cache for quotes, a per-owner allowlist, and a CLI path that needs no admin
  token (`syndromi init --server` still uses `SYNDROMI_SERVER_TOKEN`, so for testers the server-held
  path is the way in).

## Publishing the CLI to npm

You will publish when it is time. What that needs, so the clone stops being required for the CLI
paths (local runner and stdio MCP):
- One bundled package (esbuild or tsup), workspace packages inlined, real dependencies external.
- The `templates/` folder shipped inside the package, and `TEMPLATES_DIR` resolved relative to the
  installed file.
- A `bin` named `syndromi`, `engines.node >= 20`, version `0.1.0-beta.x`, npm provenance.
  The unscoped name must be checked for availability; `@syndromi/cli` is the fallback.
- `claudeAddCommand` stops pointing at a repo path and prints
  `claude mcp add … -- npx -y syndromi mcp <dir>`.
- No stdout noise: `npx -y` is fine, `pnpm` banners were the problem.

Remote MCP makes this optional for the beta, since testers can skip the CLI entirely.

## Hosting and a stable address

Topology:

```
tester's AI ──► https://api.<name>   Caddy ─► server (Hono :8787)  ── SQLite on a volume
tester's browser ─► https://<app>    Vercel ─► Next.js dashboard ──► calls the server (CORS)
phone / Telegram ─► https://api.<name>/approve/…
```

- **Dashboard on Vercel.** It is a self-contained Next.js app with no API routes and no
  Node-only code, so serverless is fine. Set the project root to `apps/dashboard` and
  `NEXT_PUBLIC_SYNDROMI_SERVER` to the API origin **before building** (it is inlined at build).
- **Server on the VPS, not serverless.** It owns long-lived pieces: the Telegram long-polling bot,
  cron and watcher timers, a SQLite file, and (new) streaming MCP responses. Serverless cannot
  hold those.
- `DASHBOARD_ORIGINS` must list the dashboard's origin. Only one Telegram poller may run per bot
  token, so stop any local server before the VPS one starts.

### Running now (Oct 2): Render + Neon + Vercel

A free trial of the topology above, before the VPS:

- **Server:** a free Render web service from this repo (no `render.yaml`): build
  `npx --yes pnpm@12.5.1 install --frozen-lockfile`, start `./node_modules/.bin/tsx apps/server/src/main.ts`,
  `NODE_VERSION=24`, health check `/`. URL `https://syndromi.onrender.com`.
- **Data:** Neon Postgres through `DATABASE_URL` (the direct connection; the pooled one is for
  serverless callers). Render's free tier wipes local files on every sleep and deploy, so SQLite
  there loses agents, sessions and hosted keys. The store runs on SQLite or Postgres behind one
  async interface; `pnpm test` covers both when `SYNDROMI_TEST_DATABASE_URL` is set (it uses a
  throwaway schema).
- **Dashboard:** Vercel project `syndromi` (root `apps/dashboard`), Git-connected, production from
  `main`, at `https://syndromi.vercel.app`.
- **Telegram for testers:** the bot is public. A signed-in owner presses **Connect Telegram**
  (dashboard), which issues a one-time link for their wallet (10 minutes, single use); `/start <code>`
  binds the chat. One chat can hold several wallets; each owner's alerts go only to their chats, and
  Reject works only for items of a wallet linked to the chat. Signing in the wallet is still the only
  way to approve. With `TELEGRAM_WEBHOOK_SECRET` set (and an https `PUBLIC_URL`) updates arrive by
  webhook at `/telegram/webhook`, so a message wakes a sleeping server (about a minute for the first
  reply; Telegram retries meanwhile). It does not keep the server awake: schedules, the approval
  watcher and the sweeper still pause while it sleeps.
- **Still limited:** the free instance sleeps after 15 minutes without requests (about a minute to
  wake), and while asleep the Telegram bot, the approval watcher and the expiry sweeper pause. A
  paid instance or the VPS removes that; the data no longer depends on it.
- **Decided Oct 5: a paid Render instance, not the VPS.** A sleeping server is worst for the path
  the beta is about: a tester's AI calling `/agent/mcp` hangs for the minute it takes to wake, and
  the client gives up. The VPS packaging below (Docker, Caddy, DuckDNS) is not being built. Set the
  service's health check path to `/healthz` (the process is up and the store answers; it returns
  `{ ok, hosted, telegram }`). The dashboard pings it: until the first answer it shows "Connecting
  to the server…", which now only happens while a deploy restarts the server, and afterwards a lost
  connection shows a notice without clearing the page.

### Test tokens and the faucet (Beta phase 4, Oct 5)

Testers no longer need Circle's faucet. syndromí runs its own devnet test tokens:

- **Mints:** test USDC `8wvXYteqfNieCn4RVC8rnDSGgugHkMbPT4x8KnMeneVd` (6 decimals) and test JitoSOL
  `HHauXVZsFjs1UFCoBJun9dwmCMhbLPVxnmEpxPqRcdpv` (9 decimals): classic SPL Token, no freeze
  authority, no Token-2022 extensions (the Subscriptions program rejects several). Created by
  `pnpm beta:setup` (`scripts/beta-setup.ts`), which is safe to run again.
- **Devnet twins:** they are registered as the `devnet` mints of `USDC` and `JitoSOL`. The policy
  treats an unpriced token as "needs approval", so a token with no price would turn every action
  into an approval request; a twin is priced as its mainnet token, and templates and prompts that
  say `USDC` work on every network. The dashboard says they are test tokens with no value.
- **Treasury:** `nZ1VHF3Xk6YsbL4cwgqFt1pqhkN1twCKdnbGneuUQMV`, the mint authority. Its key is
  `SYNDROMI_TREASURY_KEY` on the server (a JSON byte array; locally `~/.syndromi/treasury.json`).
  Back it up with `SYNDROMI_HOSTED_SECRET`: losing it means new mints and a registry change. It
  spends a little devnet SOL (fees, and about 0.002 SOL of rent for each new wallet's token
  account); `/healthz` reports `faucet.low` below 0.05 SOL.
- **Faucet:** `POST /owner/faucet` (signed-in owner, devnet): 100 test USDC
  (`SYNDROMI_FAUCET_USDC`) per wallet per day, recorded in `faucet_claims`. A failed mint gives the
  claim back. The dashboard's wallet card has the button; `syndromi faucet --server <url>` does the
  same for the CLI's owner wallet, signing in with the owner key (no admin token).
- **Devnet SOL is the tester's job** (decided Oct 5, to keep this simple): the dashboard links to
  the public Solana faucet when the wallet is low. That faucet is rate-limited and sometimes fails;
  if testers get stuck there, a SOL drip is the fix.
- **Existing devnet agents** funded with Circle's devnet USDC keep their onchain allowance, but the
  token now shows as a mint address. Revoke and recreate them.

### A pool to swap in (Beta phase 5, Oct 5)

- **Pool:** `HRjoKcD6XQWZhnVFyjp7ViZtAuvLtx4wfvLXb2xfvq3H`, an Orca Splash Pool (full range, 1%
  fee) for test USDC / test JitoSOL on Orca's devnet deployment, created by `pnpm beta:setup` at
  the live JitoSOL price with 1,000,000 test USDC and the matching JitoSOL from the treasury. A
  100 USDC swap moves it by about 0.01%.
- **Tools:** `orca-quote` and `orca-swap` (devnet only), and an `orca` program permission. The
  three templates list them next to the Jupiter tools; `jupiter-*` on devnet now answers "use
  `orca-swap`". Agents created before this need the tools and the permission added to swap.
- **Keeper:** runs in the server when the treasury key is set; see architecture, decision 4.
- **Checked for real on devnet:** `SYNDROMI_DEVNET_E2E=1 pnpm test packages/runtime/src/devnet.test.ts`
  grants an allowance in test USDC, then a scripted run pulls it, swaps 3 USDC (executed), tries 6
  (held for approval), tries a transfer to a stranger (blocked) and asks for a top-up. It needs the
  treasury key and sends real devnet transactions, so it is skipped unless asked for.

### The guided run (Beta phase 6, Oct 5)

A new owner sees the rules work before connecting anything: no AI, no key, no install.

- **A scripted model is first class.** `model: script:tour` in a manifest runs a fixed list of
  tool calls (`tourScript` in `packages/runtime/src/llm/index.ts`) instead of an LLM. It goes
  through `runOnce` and `callTool` like any agent, so every verdict is the real policy's. Such an
  agent needs no key, schedule or prompt. This is separate from the `demo.*` switches, which stay
  for the injection demo only.
- **The tour** (`templates/guided-tour`, 20 test USDC a week, $5 approval threshold, $10 cap):
  check balances; pull 10 USDC (executes); quote and swap 3 USDC on the test pool (executes); swap
  6 USDC (held: above the threshold); send 1 USDC to an address nobody allowed (blocked); ask for
  a 10 USDC top-up. A test keeps the script's amounts and the template's rules in step.
- **Dashboard:** the overview shows **Try a guided run** to an owner with no agents (and for as
  long as their tour agent exists): get devnet SOL, get test USDC, create the tour agent, fund it,
  run it, then "do it with your own AI" (the wizard). Agent names are unique per server, so each
  owner's tour agent is `tour-<first 8 characters of their address>`. The wizard does not list the
  tour template.
- **Why not instead of a real AI:** the tester's AI was never the obstacle to key safety (we hold
  no model keys; the tester's AI connects with a per-agent token). The script is there because
  the first minute should not require setting up an MCP client.
- **Checked for real on devnet:** through a local server, as the dashboard drives it: create,
  fund, run (two executed, one held, one blocked, one top-up request), approve the held swap (the
  server executed it), approve the top-up (the server pulled it).
  `SYNDROMI_DEVNET_E2E=1 pnpm test packages/runtime/src/devnet.test.ts` repeats the run itself.
  The card was built and type-checked but not yet looked at in a browser.

### Managing agents from Telegram (Beta phase 7, Oct 5)

- **The rule: Telegram can only tighten.** Rejecting, pausing and revoking an AI's access need no
  signature, so the bot may do them. Approving, resuming and anything that raises a limit happen in
  the wallet or in the signed-in dashboard. A stolen Telegram account can stop agents; it can never
  give one more room. No button in the bot loosens anything (a test checks there is no resume).
- **`/status`:** every agent of the chat's wallets, per network: where it runs, what is left of its
  allowance and when it resets, how many requests wait, and whether it is paused. **Refresh** edits
  the message in place; **Pending** sends the waiting requests. It is built from the same
  `buildOverview` (`apps/server/src/overview.ts`) as the dashboard, so the two cannot disagree.
- **Agent card** (the **Manage** button): **Pause**, **Revoke AI access** (server-held agents: all
  of its access tokens), and a link to its dashboard page. Buttons work only for a chat linked to
  the agent's owner; anyone else is told "Not allowed." and nothing about the agent. A second tap
  answers "Already paused." and changes nothing.
- **Pause** (`apps/server/src/pause.ts`) is a `paused` flag on the agent record, enforced by the
  server: a hosted agent skips its runs (and **Run now** is refused), and a server-held agent's AI
  gets "the owner has paused this agent" for every write call while reads still work. What the
  owner already approved still executes. It revokes nothing onchain and means nothing for an agent
  that holds its own key, which is why those cannot be paused and the bot points at `/kill`.
  Resume is `POST /owner/agents/:name/resume`, a button on the agent's dashboard page.
- **Not checked live:** the bot's handlers are tested against a recorded Telegram API, not the
  real bot, because only one server may hold a bot's updates and the hosted one does.

### Choosing the domain

| Option | Stable? | Cost | Fit |
|---|---|---|---|
| **DuckDNS** + Caddy on the VPS | yes, while you keep the subdomain | free | good for the test. Persist Caddy's data volume: Let's Encrypt allows 5 identical certificates per 7 days, and reinstalling repeatedly hits it. DuckDNS is donation-funded, so expect the odd outage |
| **Your own domain** (Cloudflare DNS) | yes | a small yearly fee (check registrar prices) | best for a product beta. Same topology, nicer names (`app.`, `api.`), email, Vercel custom domain, optional Cloudflare named tunnel |
| **Tailscale Funnel** | yes (`<machine>.<tailnet>.ts.net`) | free | works with no domain and no open ports; HTTPS only for its own `ts.net` names, ports 443, 8443 and 10000, with non-configurable bandwidth limits. Good staging or fallback |
| **ngrok free** | static name exists | free | not suitable: the 2026 free tier has 2-hour sessions, 1 GB a month and an interstitial page |
| **Cloudflare quick tunnel** | no (random per start) | free | demos only. This is what we use now |

Recommendation: start with **DuckDNS** for the VPS API and Vercel's own `*.vercel.app` name for the
dashboard, since both cost nothing and are stable enough. Before inviting people beyond friends,
register a real domain and move the API and dashboard onto it. The move is configuration only
(`PUBLIC_URL`, `DASHBOARD_ORIGINS`, `NEXT_PUBLIC_SYNDROMI_SERVER`, then a Vercel rebuild).

### Packaging

- **Sizing** (measured on a laptop, so treat as indicative): the server under `tsx` used about
  166 MB resident (288 MB peak) plus a 55 MB launcher; `next start` idled at about 122 MB. Add Caddy,
  Docker and the OS, and the full stack does not fit in 512 MB. See "Server size" below.
- A multi-stage `Dockerfile` (Node 24, because `node:sqlite` is built in; pnpm workspace install).
- `docker-compose.yml`: Caddy (80/443, automatic TLS) and the server (internal port only), volumes
  for the database and Caddy's state, an env file kept out of the image.
- A `/healthz` endpoint, and a SQLite backup job. **Back up `SYNDROMI_HOSTED_SECRET` separately:**
  losing it loses every server-held key.
- A short deploy guide, including the Telegram re-link and the one-poller rule.

### Server size (DigitalOcean)

Plans per the search results (verify on DigitalOcean's pricing page before buying): Basic 512 MB at
$4 a month (1 vCPU, 10 GB disk), Basic 1 GB at $6 (25 GB), Basic 2 GB at $12 (50 GB).

| Layout | Memory needed (rough) | Plan |
|---|---|---|
| Server + Caddy, no Docker, precompiled JS | about 300 MB | 512 MB works but is tight (the server peaked at 288 MB) |
| Server + Caddy in Docker, dashboard on Vercel | about 450 MB | **1 GB with a swap file (the beta default)** |
| Everything on one droplet (server, dashboard, Caddy, Docker) | about 700 MB, more at peak | 2 GB |

Do not run `pnpm install` or `next build` on the droplet; build the image elsewhere and pull it.
Precompiling the server to JavaScript instead of running it through `tsx` would save the launcher
process and some memory; that is an optional optimisation.

## Work plan

Beta phase 0 (done): external agents, `mcp-agent` template, stdio MCP, BYO-AI README section.

Beta phase 1: ship a reachable server
1. Dockerfile, compose, Caddyfile, `/healthz`, env template, deploy guide.
2. DuckDNS name, VPS up, Telegram relinked, Vercel project with the dashboard.
3. Hide `fork` (flag), set hosted schedules off by default for the beta.

Beta phase 2: remote agents (the core) — built Oct 2
4. Token store: table, hashing, create, list, revoke; owner endpoints; kill switch disables them.
5. Server-held external agents: `custody` on the record, `HostedRuntime` watcher-only loading,
   wizard option, devnet-only guard.
6. `/agent/v1` HTTP API with rate limits and body limits.
7. `/agent/mcp` over the web-standard Streamable HTTP transport; Origin validation.
8. Dashboard **Connect an AI** card; verified client snippets.
9. Tests: token lifecycle, policy block over both doors, rate limits, revoke, kill switch, an
   end-to-end MCP client call.

Beta phase 3: beta polish
10. npm publish of the bundled CLI (yours, when ready); `claudeAddCommand` update.
11. Real domain, move the two origins.
12. Optional browser chat panel; framework adapters on `/agent/v1`.

Rough effort: beta phase 1 about a day, beta phase 2 about two days, beta phase 3 as time allows.

## Decisions needed

1. ~~Server-held keys for testers (devnet)~~ **Decided: yes**, devnet only. Testers bring their own
   AI; the server never holds their provider keys.
2. ~~Token lifetime~~ **Decided: 30 days by default**, with a picker (1, 7, 30, 90 days).
3. **Invite-only or open.** Sign-in is open to any wallet today. With no model keys to protect, open
   is acceptable, but the per-owner limits matter. An optional owner allowlist is a small add.
4. **Domain.** DuckDNS first, a real domain before the wider beta?
5. **npm name.** `syndromi` if it is free, otherwise `@syndromi/cli`.
