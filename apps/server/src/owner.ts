// The dashboard's API: owner sign-in, then everything scoped to that owner's agents.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Address, address, isAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
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
  toUiAmount,
} from "@syndromi/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serialize } from "./api.js";
import type { ServerContext } from "./context.js";
import type { AgentRecord } from "./db.js";
import { challenge, signIn } from "./sessions.js";

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
      return c.json(challenge(store, address ?? ""));
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
    const who = store.sessionOwner(token);
    if (!who) return c.json({ error: "sign in first" }, 401);
    c.set("owner", who);
    await next();
  });

  owner.get("/overview", async (c) => {
    const cluster = clusterParam(c.req.query("cluster"));
    const who = c.get("owner") as Address;
    const rpc = ctx.rpc(cluster);
    const usdc = findToken("USDC", networkOf(cluster));
    const usdcMint = usdc ? mintFor(usdc, networkOf(cluster)) : undefined;
    const [sol, bag, delegations] = await Promise.all([
      rpc
        .getBalance(who)
        .send()
        .then((r) => r.value)
        .catch(() => 0n),
      usdcMint
        ? findAssociatedTokenPda({
            owner: who,
            mint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          })
            .then(([ata]) => rpc.getTokenAccountBalance(ata).send())
            .then((r) => BigInt(r.value.amount))
            .catch(() => 0n)
        : Promise.resolve(0n),
      listDelegations(rpc, who).catch(() => []),
    ]);
    const agents = store.agents(who).filter((a) => a.cluster === cluster);
    const pendingDrafts = store
      .drafts({ status: "pending" })
      .filter((d) => d.owner === who && d.cluster === cluster);
    const pendingTopUps = store
      .topUps({ status: "pending" })
      .filter((t) => t.owner === who && t.cluster === cluster);
    const perPeriod: Record<string, number> = {};
    const view = agents.map((a) => {
      const own = delegations.filter((d) => d.agent === a.address);
      const allowance = own.find((d) => d.kind === "allowance");
      if (allowance && a.allowance) {
        perPeriod[a.allowance.period] = (perPeriod[a.allowance.period] ?? 0) + a.allowance.amount;
      }
      return {
        ...publicAgent(a),
        funded: Boolean(allowance),
        nextRun: a.runtime === "hosted" ? (ctx.hosted?.nextRun?.(a.name)?.getTime() ?? null) : null,
        allowanceLeft: allowance
          ? {
              remaining: toUiAmount(allowance.remaining, 6),
              limit: toUiAmount(allowance.limit, 6),
              periodEndsAt: allowance.periodEndsAt
                ? Number(allowance.periodEndsAt) * 1000
                : undefined,
            }
          : undefined,
        topUps: own
          .filter((d) => d.kind === "top-up")
          .map((d) => ({
            remaining: toUiAmount(d.remaining, 6),
            expiresAt: Number(d.expiresAt) * 1000,
          })),
        pending:
          pendingDrafts.filter((d) => d.agentName === a.name).length +
          pendingTopUps.filter((t) => t.agentName === a.name).length,
      };
    });
    return c.json(
      serialize({
        owner: who,
        cluster,
        bag: { usdc: toUiAmount(bag, 6), sol: toUiAmount(sol, 9), usdcMint },
        allocatedPerPeriod: perPeriod,
        agents: view,
        pending: {
          drafts: pendingDrafts.map((d) => ({
            id: d.id,
            agentName: d.agentName,
            summary: d.summary,
            usd: d.usd,
            expiresAt: d.expiresAt,
            reasons: d.decision.reasons,
          })),
          topups: pendingTopUps.map((t) => ({
            id: t.id,
            agentName: t.agentName,
            amount: toUiAmount(t.amount, 6),
            reason: t.reason,
            expiresAt: t.expiresAt,
          })),
        },
      }),
    );
  });

  owner.get("/activity", (c) => {
    const who = c.get("owner");
    const names = store.agents(who).map((a) => a.name);
    const agent = c.req.query("agent");
    const after = c.req.query("after");
    const events = store.activity({
      agentNames: agent ? names.filter((n) => n === agent) : names,
      ...(after ? { after: Number(after) } : {}),
      limit: 200,
    });
    return c.json(serialize({ events }));
  });

  owner.get("/agents/:name", (c) => {
    const agent = store.agent(c.req.param("name"));
    if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
    return c.json(serialize(publicAgent(agent)));
  });

  owner.get("/templates", async (c) => c.json(await loadTemplates()));

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
    };
    const template = (await loadTemplates()).find((t) => t.name === body.template);
    if (!template) return c.json({ error: `unknown template ${body.template}` }, 400);
    const result = await createHostedAgent(ctx, {
      manifest: body.manifest,
      prompt: template.prompt,
      owner: who,
      cluster: clusterParam(body.cluster),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(serialize(publicAgent(result.agent)));
  });

  // Run a hosted agent now (the dashboard's "Run now"); results arrive in the activity feed.
  owner.post("/agents/:name/run", (c) => {
    const agent = store.agent(c.req.param("name"));
    if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
    if (agent.runtime !== "hosted") return c.json({ error: `${agent.name} runs locally` }, 409);
    if (!ctx.hosted)
      return c.json({ error: "hosted runtime is off (set SYNDROMI_HOSTED_SECRET)" }, 503);
    const started = ctx.hosted.runNow(agent.name);
    return c.json({ started });
  });

  // Remove an agent the owner no longer wants. Only when nothing is delegated to it and nothing
  // waits for approval; a hosted key is archived, not deleted (its wallet may hold funds).
  owner.delete("/agents/:name", async (c) => {
    const agent = store.agent(c.req.param("name"));
    if (!agent || agent.owner !== c.get("owner")) return c.json({ error: "no such agent" }, 404);
    const pending =
      store.drafts({ agentName: agent.name, status: "pending" }).length +
      store.topUps({ agentName: agent.name, status: "pending" }).length;
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
        { error: `could not check ${agent.name}'s delegations: ${(e as Error).message}` },
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
    store.removeAgent(agent.name);
    return c.json({ removed: agent.name });
  });

  app.route("/owner", owner);
}

/**
 * Create a hosted agent: validate the manifest, generate its key, store the key encrypted with
 * SYNDROMI_HOSTED_SECRET. Used by the dashboard wizard and by `syndromi deploy`.
 */
export async function createHostedAgent(
  ctx: ServerContext,
  args: { manifest: unknown; prompt: string; owner: Address; cluster: Cluster },
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
  const parsed = manifestSchema.safeParse({ ...(args.manifest as object), runtime: "hosted" });
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`),
    };
  }
  const manifest = parsed.data;
  if (ctx.store.agent(manifest.name)) {
    return { ok: false, status: 409, error: `an agent named ${manifest.name} exists` };
  }
  let mint: Address;
  try {
    mint = resolveMint(manifest, args.cluster);
  } catch (e) {
    return { ok: false, status: 400, error: (e as Error).message };
  }
  const keypair = await generateAgentKeypair();
  ctx.store.saveHostedKey(manifest.name, await encryptKeypair(keypair, secret));
  const agent: AgentRecord = {
    ...registrationFor(manifest, keypair.signer.address, args.owner, args.cluster, mint),
    registeredAt: new Date().toISOString(),
    manifest: manifest as unknown as Record<string, unknown>,
    prompt: args.prompt,
  };
  ctx.store.upsertAgent(agent);
  ctx.hosted?.scan();
  return { ok: true, agent };
}

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
  return {
    name: a.name,
    address: a.address,
    cluster: a.cluster,
    runtime: a.runtime ?? "local",
    allowance: a.allowance,
    feeBudgetSol: a.feeBudgetSol,
    rules: a.rules,
    ruleCard: card,
    registeredAt: a.registeredAt,
    /** Demo-only agents (the injection demo) are labelled as such in the dashboard. */
    demo: Boolean(a.manifest && (a.manifest as { demo?: unknown }).demo),
  };
}

export async function loadTemplates() {
  const names = await readdir(TEMPLATES_DIR).catch(() => [] as string[]);
  const templates = [];
  for (const name of names.sort()) {
    const yaml = await readFile(join(TEMPLATES_DIR, name, "manifest.yaml"), "utf8").catch(
      () => undefined,
    );
    if (!yaml) continue;
    const parsed = parseManifest(yaml, `${name}/manifest.yaml`);
    if (!parsed.ok) continue;
    const prompt = await readFile(join(TEMPLATES_DIR, name, parsed.manifest.prompt), "utf8").catch(
      () => "",
    );
    templates.push({
      name,
      manifest: parsed.manifest,
      prompt,
      ruleCard: ruleCard(parsed.manifest),
    });
  }
  return templates;
}
