// The dashboard's API: owner sign-in, then everything scoped to that owner's agents.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Address, address, isAddress } from "@solana/kit";
import {
  type Cluster,
  encryptKeypair,
  findToken,
  generateAgentKeypair,
  listDelegations,
  type Manifest,
  manifestSchema,
  mintFor,
  networkOf,
  parseManifest,
  ruleCard,
  scriptOf,
} from "@syndromi/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { serialize } from "./api.js";
import { claimTestTokens } from "./beta/faucet.js";
import type { ServerContext } from "./context.js";
import { type AgentRecord, TokenLimit } from "./db.js";
import { buildOverview } from "./overview.js";
import { canPause, setPaused, WHY_NOT_PAUSABLE } from "./pause.js";
import { RecordError, reject } from "./records.js";
import { challenge, signIn } from "./sessions.js";
import { createAgentToken } from "./tokens.js";

export const TEMPLATES_DIR = new URL("../../../templates/", import.meta.url).pathname;
const CLUSTERS: Cluster[] = ["devnet", "mainnet", "fork"];

type Env = { Variables: { owner: string } };

export function mountOwner(app: Hono, ctx: ServerContext) {
  const { store, config } = ctx;
  const owner = new Hono<Env>();

  owner.use(
    "*",
    cors({
      origin: config.dashboardOrigins,
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  owner.post("/session/challenge", async (c) => {
    const { owner: address } = (await c.req.json().catch(() => ({}))) as { owner?: string };
    try {
      return c.json(await challenge(store, address ?? ""));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  owner.post("/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      owner?: string;
      nonce?: string;
      signature?: string;
    };
    try {
      return c.json(
        await signIn(store, {
          owner: body.owner ?? "",
          nonce: body.nonce ?? "",
          signature: body.signature ?? "",
        }),
      );
    } catch (e) {
      return c.json({ error: (e as Error).message }, 401);
    }
  });

  owner.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const who = await store.sessionOwner(token);
    if (!who) return c.json({ error: "sign in first" }, 401);
    c.set("owner", who);
    await next();
  });

  owner.get("/overview", async (c) =>
    c.json(
      serialize(
        await buildOverview(ctx, c.get("owner") as Address, clusterParam(c.req.query("cluster"))),
      ),
    ),
  );

  // Test tokens for the signed-in wallet, on devnet (one claim a day).
  owner.post("/faucet", async (c) => {
    const result = await claimTestTokens(ctx, c.get("owner") as Address);
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.nextAt ? { nextAt: result.nextAt } : {}) },
        result.status,
      );
    }
    return c.json(result);
  });

  owner.get("/activity", async (c) => {
    const who = c.get("owner");
    const names = (await store.agents(who)).map((a) => a.name);
    const agent = c.req.query("agent");
    const after = c.req.query("after");
    const events = await store.activity({
      agentNames: agent ? names.filter((n) => n === agent) : names,
      ...(after ? { after: Number(after) } : {}),
      limit: 200,
    });
    return c.json(serialize({ events }));
  });

  owner.get("/agents/:name", async (c) => {
    const agent = await store.agent(c.req.param("name"));
    if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
    return c.json(serialize(publicAgent(agent)));
  });

  owner.get("/templates", async (c) => c.json(await loadTemplates()));

  // Telegram: the dashboard's "Connect Telegram". The link binds whichever chat opens it to this
  // signed-in wallet; nothing here grants access to anything but alerts.
  owner.get("/telegram", async (c) =>
    c.json({
      enabled: Boolean(ctx.telegram),
      chats: (await store.telegramChats(c.get("owner"))).length,
    }),
  );
  owner.post("/telegram/link", async (c) => {
    if (!ctx.telegram) return c.json({ error: "Telegram is not set up on this server" }, 503);
    return c.json(await ctx.telegram.linkUrlFor(c.get("owner")));
  });
  owner.delete("/telegram", async (c) =>
    c.json({ unlinked: await store.unlinkTelegram(c.get("owner")) }),
  );

  // Live wizard preview: validate an edited manifest and describe it in plain language.
  owner.post("/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { manifest?: unknown; runtime?: string };
    const parsed = manifestSchema.safeParse({
      ...(body.manifest as object),
      ...(body.runtime ? { runtime: body.runtime } : {}),
    });
    if (!parsed.success) {
      return c.json({
        ok: false,
        errors: parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`),
      });
    }
    return c.json({ ok: true, ruleCard: ruleCard(parsed.data) });
  });

  owner.post("/agents", async (c) => {
    const who = c.get("owner") as Address;
    const body = (await c.req.json().catch(() => ({}))) as {
      template?: string;
      cluster?: string;
      manifest?: unknown;
      custody?: string;
    };
    const template = (await loadTemplates()).find((t) => t.name === body.template);
    if (!template) return c.json({ error: `unknown template ${body.template}` }, 400);
    const serverHeld = body.custody === "server";
    if (serverHeld && template.manifest.runtime !== "external") {
      return c.json(
        { error: `${template.name} runs its own model; only external agents can be server-held` },
        400,
      );
    }
    const result = await createHostedAgent(ctx, {
      manifest: body.manifest,
      prompt: template.prompt,
      owner: who,
      cluster: clusterParam(body.cluster),
      ...(serverHeld ? { custody: "server" as const } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(serialize(publicAgent(result.agent)));
  });

  // Run a hosted agent now (the dashboard's "Run now"); results arrive in the activity feed.
  owner.post("/agents/:name/run", async (c) => {
    const agent = await store.agent(c.req.param("name"));
    if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
    if (agent.runtime !== "hosted") {
      const where = agent.runtime === "external" ? "is driven by an MCP client" : "runs locally";
      return c.json({ error: `${agent.name} ${where}` }, 409);
    }
    if (agent.paused) return c.json({ error: `${agent.name} is paused; resume it first` }, 409);
    if (!ctx.hosted)
      return c.json({ error: "hosted runtime is off (set SYNDROMI_HOSTED_SECRET)" }, 503);
    const started = ctx.hosted.runNow(agent.name);
    return c.json({ started });
  });

  // Say no to a held request (an approval request `d_…` or a top-up `t_…`). Rejecting needs no
  // signature: it only ever stops something.
  owner.post("/requests/:id/reject", async (c) => {
    const id = c.req.param("id") ?? "";
    const kind = id.startsWith("d_") ? "draft" : id.startsWith("t_") ? "topup" : undefined;
    const record =
      kind === "draft" ? await store.draft(id) : kind ? await store.topUp(id) : undefined;
    if (!kind || !record || record.owner !== c.get("owner")) {
      return c.json({ error: "no such request" }, 404);
    }
    try {
      const updated = await reject(ctx, kind, id);
      return c.json({ id, status: updated.status });
    } catch (e) {
      if (e instanceof RecordError) return c.json({ error: e.message }, e.status as 404 | 409);
      throw e;
    }
  });

  // Pause: stop one agent acting without revoking anything. Resume is only here (a signed-in
  // owner), never in Telegram: pausing tightens, resuming loosens.
  for (const [verb, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    owner.post(`/agents/:name/${verb}`, async (c) => {
      const agent = await store.agent(c.req.param("name"));
      if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
      if (!canPause(agent)) return c.json({ error: `${agent.name} ${WHY_NOT_PAUSABLE}` }, 409);
      const result = await setPaused(ctx, agent, paused, "the dashboard");
      return c.json(serialize({ ...publicAgent(result.agent), changed: result.changed }));
    });
  }

  // Remove an agent the owner no longer wants. Only when nothing is delegated to it and nothing
  // waits for approval; a hosted key is archived, not deleted (its wallet may hold funds).
  owner.delete("/agents/:name", async (c) => {
    const agent = await store.agent(c.req.param("name"));
    if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
    const pending =
      (await store.drafts({ agentName: agent.name, status: "pending" })).length +
      (await store.topUps({ agentName: agent.name, status: "pending" })).length;
    if (pending > 0) {
      return c.json(
        { error: `${agent.name} has ${pending} request(s) waiting; reject them first` },
        409,
      );
    }
    let live: number;
    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      live = (await listDelegations(ctx.rpc(agent.cluster), agent.owner, now)).filter(
        (d) => d.agent === agent.address && (d.kind === "allowance" || d.remaining > 0n),
      ).length;
    } catch (e) {
      return c.json(
        { error: `could not check ${agent.name}'s allowances: ${(e as Error).message}` },
        502,
      );
    }
    if (live > 0) {
      return c.json(
        { error: `${agent.name} still has a live allowance; revoke it first (kill switch)` },
        409,
      );
    }
    ctx.hosted?.unload?.(agent.name);
    await store.removeAgent(agent.name);
    return c.json({ removed: agent.name });
  });

  // Access tokens for the owner's AI (remote MCP and the HTTP API) on a server-held agent. The
  // secret is returned once, at creation; lists carry only the prefix.
  const tokenAgent = async (c: Context<Env>) => {
    const agent = await store.agent(c.req.param("name") ?? "");
    if (!agent || agent.owner !== c.get("owner")) {
      return { error: c.json({ error: "no such agent" }, 404) };
    }
    if (agent.custody !== "server") {
      return {
        error: c.json(
          { error: `${agent.name} holds its own key; tokens are for server-held agents` },
          409,
        ),
      };
    }
    return { agent };
  };
  const tokenEvent = (agent: AgentRecord, status: string, prefix: string) =>
    store.addActivity(agent.name, {
      type: "approval",
      at: new Date().toISOString(),
      kind: "token",
      status,
      summary: `access token ${prefix}… ${status}`,
      cluster: agent.cluster,
    });

  owner.get("/agents/:name/tokens", async (c) => {
    const { agent, error } = await tokenAgent(c);
    if (!agent) return error;
    return c.json({ tokens: await store.tokens(agent.name) });
  });

  owner.post("/agents/:name/tokens", async (c) => {
    const { agent, error } = await tokenAgent(c);
    if (!agent) return error;
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; days?: unknown };
    try {
      const created = await createAgentToken(ctx, agent, {
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(typeof body.days === "number" ? { days: body.days } : {}),
      });
      await tokenEvent(agent, "created", created.record.prefix);
      return c.json({ token: created.token, ...created.record }, 201);
    } catch (e) {
      if (e instanceof TokenLimit) return c.json({ error: e.message }, 409);
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  owner.delete("/agents/:name/tokens/:id", async (c) => {
    const { agent, error } = await tokenAgent(c);
    if (!agent) return error;
    const id = c.req.param("id") ?? "";
    const token = (await store.tokens(agent.name)).find((t) => t.id === id);
    if (!token || !(await store.revokeToken(agent.name, id))) {
      return c.json({ error: "no such live token" }, 404);
    }
    await tokenEvent(agent, "revoked", token.prefix);
    return c.json({ revoked: id });
  });

  app.route("/owner", owner);
}

/**
 * Create a hosted agent: validate the manifest, generate its key, store the key encrypted with
 * SYNDROMI_HOSTED_SECRET. Used by the dashboard wizard and by `syndromi deploy`.
 */
export async function createHostedAgent(
  ctx: ServerContext,
  args: {
    manifest: unknown;
    prompt: string;
    owner: Address;
    cluster: Cluster;
    /** `server`: an external agent whose key lives here, reached by the owner's AI with a token. */
    custody?: "server";
  },
): Promise<
  | { ok: true; agent: AgentRecord }
  | { ok: false; status: 400 | 409 | 500; error: string | string[] }
> {
  const secret = ctx.config.env.SYNDROMI_HOSTED_SECRET ?? "";
  if (secret.length < 32) {
    return {
      ok: false,
      status: 500,
      error: "hosted agents need SYNDROMI_HOSTED_SECRET (32+ characters) on the server",
    };
  }
  if (args.custody === "server" && args.cluster !== "devnet") {
    return {
      ok: false,
      status: 400,
      error: "server-held agents are devnet only; use your own key (syndromi mcp) elsewhere",
    };
  }
  const parsed = manifestSchema.safeParse({
    ...(args.manifest as object),
    runtime: args.custody === "server" ? "external" : "hosted",
  });
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`),
    };
  }
  const manifest = parsed.data;
  if (await ctx.store.agent(manifest.name)) {
    return { ok: false, status: 409, error: `an agent named ${manifest.name} exists` };
  }
  if ((await ctx.store.agents(args.owner)).length >= MAX_AGENTS_PER_OWNER) {
    return {
      ok: false,
      status: 409,
      error: `you can have at most ${MAX_AGENTS_PER_OWNER} agents; remove one first`,
    };
  }
  let mint: Address;
  try {
    mint = resolveMint(manifest, args.cluster);
  } catch (e) {
    return { ok: false, status: 400, error: (e as Error).message };
  }
  const keypair = await generateAgentKeypair();
  await ctx.store.saveHostedKey(manifest.name, await encryptKeypair(keypair, secret));
  const agent: AgentRecord = {
    ...registrationFor(manifest, keypair.signer.address, args.owner, args.cluster, mint),
    registeredAt: new Date().toISOString(),
    manifest: manifest as unknown as Record<string, unknown>,
    prompt: args.prompt,
    ...(args.custody ? { custody: args.custody } : {}),
  };
  await ctx.store.upsertAgent(agent);
  ctx.hosted?.scan();
  return { ok: true, agent };
}

/** Agents (hosted and server-held) one owner may create through the dashboard or `deploy`. */
export const MAX_AGENTS_PER_OWNER = 5;

function clusterParam(value: string | undefined): Cluster {
  return CLUSTERS.includes(value as Cluster) ? (value as Cluster) : "devnet";
}

function resolveMint(m: Manifest, cluster: Cluster): Address {
  const network = networkOf(cluster);
  const token = findToken(m.allowance.mint, network);
  if (token) return mintFor(token, network);
  if (isAddress(m.allowance.mint)) return address(m.allowance.mint);
  throw new Error(`allowance.mint ${m.allowance.mint} is unknown on ${network}`);
}

export function registrationFor(
  m: Manifest,
  agent: Address,
  owner: Address,
  cluster: Cluster,
  allowanceMint: Address,
): Omit<AgentRecord, "registeredAt"> {
  return {
    name: m.name,
    address: agent,
    owner,
    cluster,
    allowanceMint,
    runtime: m.runtime,
    allowance: m.allowance,
    feeBudgetSol: m.fee_budget.sol,
    rules: {
      maxTxUsd: m.permissions.max_tx_usd,
      approveAboveUsd: m.permissions.approve_above_usd,
      destinations: m.permissions.destinations,
      programs: m.permissions.programs,
    },
  };
}

/** What the dashboard may see about an agent (never keys). */
export function publicAgent(a: AgentRecord) {
  const card =
    a.allowance && a.feeBudgetSol !== undefined
      ? ruleCard({
          name: a.name,
          ...(a.runtime ? { runtime: a.runtime } : {}),
          allowance: a.allowance,
          fee_budget: { sol: a.feeBudgetSol },
          permissions: {
            programs: a.rules.programs as Manifest["permissions"]["programs"],
            destinations: a.rules.destinations as Manifest["permissions"]["destinations"],
            max_tx_usd: a.rules.maxTxUsd,
            approve_above_usd: a.rules.approveAboveUsd,
          },
        })
      : [];
  const script = scriptOf((a.manifest as { model?: string } | undefined)?.model);
  return {
    name: a.name,
    address: a.address,
    cluster: a.cluster,
    runtime: a.runtime ?? "local",
    ...(a.custody ? { custody: a.custody } : {}),
    allowance: a.allowance,
    feeBudgetSol: a.feeBudgetSol,
    rules: a.rules,
    ruleCard: card,
    registeredAt: a.registeredAt,
    /** Paused by the owner: it does not run or act until resumed (see pause.ts). */
    ...(a.paused ? { paused: true } : {}),
    /** Whether the server holds its key and so can pause it. */
    pausable: canPause(a),
    /** Demo-only agents (the injection demo) are labelled as such in the dashboard. */
    demo: Boolean(a.manifest && (a.manifest as { demo?: unknown }).demo),
    /** A scripted agent (`model: script:<name>`, e.g. the guided tour) names its script. */
    ...(script ? { script } : {}),
  };
}

export async function loadTemplates() {
  const names = await readdir(TEMPLATES_DIR).catch(() => [] as string[]);
  const templates = [];
  // The default template (for agents you already have) comes first in the wizard.
  const ordered = names.sort(
    (a, b) => Number(b === "mcp-agent") - Number(a === "mcp-agent") || a.localeCompare(b),
  );
  for (const name of ordered) {
    const yaml = await readFile(join(TEMPLATES_DIR, name, "manifest.yaml"), "utf8").catch(
      () => undefined,
    );
    if (!yaml) continue;
    const parsed = parseManifest(yaml, `${name}/manifest.yaml`);
    if (!parsed.ok) continue;
    const { prompt: promptFile } = parsed.manifest;
    const prompt = promptFile
      ? await readFile(join(TEMPLATES_DIR, name, promptFile), "utf8").catch(() => "")
      : "";
    templates.push({
      name,
      manifest: parsed.manifest,
      prompt,
      ruleCard: ruleCard(parsed.manifest),
    });
  }
  return templates;
}
