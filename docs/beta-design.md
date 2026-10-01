# Beta design: bring your own AI, remote agents, hosting

Status: proposal, written Oct 1, 2026. Nothing here is built yet except what "What exists" lists.

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
- Scope: one agent. Fields: id, agent, label, created, last used, expires (default 30 days), revoked.
  At most 3 live tokens per agent.
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

- A multi-stage `Dockerfile` (Node 24, because `node:sqlite` is built in; pnpm workspace install).
- `docker-compose.yml`: Caddy (80/443, automatic TLS) and the server (internal port only), volumes
  for the database and Caddy's state, an env file kept out of the image.
- A `/healthz` endpoint, and a SQLite backup job. **Back up `SYNDROMI_HOSTED_SECRET` separately:**
  losing it loses every server-held key.
- A short deploy guide, including the Telegram re-link and the one-poller rule.

## Work plan

Phase 0 (done): external agents, `mcp-agent` template, stdio MCP, BYO-AI README section.

Phase 1: ship a reachable server
1. Dockerfile, compose, Caddyfile, `/healthz`, env template, deploy guide.
2. DuckDNS name, VPS up, Telegram relinked, Vercel project with the dashboard.
3. Hide `fork` (flag), set hosted schedules off by default for the beta.

Phase 2: remote agents (the core)
4. Token store: table, hashing, create, list, revoke; owner endpoints; kill switch disables them.
5. Server-held external agents: `custody` on the record, `HostedRuntime` watcher-only loading,
   wizard option, devnet-only guard.
6. `/agent/v1` HTTP API with rate limits and body limits.
7. `/agent/mcp` over the web-standard Streamable HTTP transport; Origin validation.
8. Dashboard **Connect an AI** card; verified client snippets.
9. Tests: token lifecycle, policy block over both doors, rate limits, revoke, kill switch, an
   end-to-end MCP client call.

Phase 3: beta polish
10. npm publish of the bundled CLI (yours, when ready); `claudeAddCommand` update.
11. Real domain, move the two origins.
12. Optional browser chat panel; framework adapters on `/agent/v1`.

Rough effort: Phase 1 about a day, Phase 2 about two days, Phase 3 as time allows.

## Decisions needed

1. **Server-held keys for testers (devnet).** Yes or no? The design assumes yes, devnet only.
2. **Token lifetime.** 30 days by default; shorter if you prefer.
3. **Invite-only or open.** Sign-in is open to any wallet today. With no model keys to protect, open
   is acceptable, but the per-owner limits matter. An optional owner allowlist is a small add.
4. **Domain.** DuckDNS first, a real domain before the wider beta?
5. **npm name.** `syndromi` if it is free, otherwise `@syndromi/cli`.
