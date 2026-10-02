// The kill switch as an Action: revoke every delegation the owner made on a cluster, in as few
// transactions as fit (usually one). Chains to itself while anything is left.
//   GET  /actions/kill-switch?cluster=devnet
//   POST /actions/kill-switch?cluster=devnet  {account}
import type { ActionGetResponse, CompletedAction } from "@solana/actions-spec";
import type { Address } from "@solana/kit";
import { type Cluster, listDelegations, revokeAll } from "@syndromi/core";
import type { Hono } from "hono";
import type { ServerContext } from "../context.js";
import { fitsInOneTransaction, issueOwnerTx, onOwnerTxLanded } from "../owner-tx.js";
import { actionError, actionJson } from "./spec.js";

const CLUSTERS: Cluster[] = ["devnet", "mainnet", "fork"];

export function mountKillSwitch(app: Hono, ctx: ServerContext, icon: string) {
  const cluster = (value: string | undefined): Cluster =>
    CLUSTERS.includes(value as Cluster) ? (value as Cluster) : "devnet";
  const href = (c: Cluster) => `/actions/kill-switch?cluster=${c}`;

  const card = (c: Cluster, description?: string): ActionGetResponse => ({
    type: "action",
    icon,
    title: "Kill switch",
    description:
      description ??
      `Revoke every allowance and top-up your bag has granted on ${c}. Agents can no longer pull anything; nothing else is touched.`,
    label: "Revoke everything",
    links: { actions: [{ type: "transaction", href: href(c), label: "Revoke everything" }] },
  });

  app.get("/actions/kill-switch", (c) => {
    const cl = cluster(c.req.query("cluster"));
    return actionJson(c, card(cl), cl);
  });

  app.post("/actions/kill-switch", async (c) => {
    const cl = cluster(c.req.query("cluster"));
    const { account } = (await c.req.json().catch(() => ({}))) as { account?: string };
    if (!account) return actionError(c, "Connect the bag owner's wallet.", 400, cl);
    const owner = account as Address;
    const all = await revokeAll(ctx.ownerClient(cl, owner), {});
    if (!all.length)
      return actionError(c, "Nothing to revoke: no delegations on this cluster.", 409, cl);
    let count = all.length;
    while (count > 1 && !fitsInOneTransaction(owner, all.slice(0, count))) count--;
    const response = await issueOwnerTx(ctx, {
      owner,
      cluster: cl,
      kind: "kill",
      ref: String(all.length - count),
      instructions: all.slice(0, count),
      message: `Revoke ${count} delegation${count === 1 ? "" : "s"}${all.length > count ? ` (${all.length - count} more after this)` : ""}`,
    });
    return actionJson(c, response, cl);
  });

  onOwnerTxLanded(ctx, "kill", async (tx) => {
    const left = await listDelegations(ctx.rpc(tx.cluster), tx.owner).catch(() => []);
    const agents = (await ctx.store.agents(tx.owner)).filter((a) => a.cluster === tx.cluster);
    // One signature also cuts the remote access: every access token of these agents stops working.
    const tokens = await ctx.store.revokeTokensOf(agents.map((a) => a.name));
    for (const agent of agents) {
      await ctx.store.addActivity(agent.name, {
        type: "approval",
        at: new Date().toISOString(),
        kind: "kill",
        status: "revoked",
        summary: `kill switch: delegations revoked by the owner${tokens ? `; ${tokens} access token(s) revoked` : ""}`,
        cluster: tx.cluster,
        ...(tx.signature ? { signature: tx.signature } : {}),
      });
    }
    ctx.bus.emit("activity", "kill-switch", {
      type: "kill",
      owner: tx.owner,
      left: left.length,
      cluster: tx.cluster,
    });
    if (left.length)
      return card(tx.cluster, `${left.length} delegation(s) left. Sign again to revoke the rest.`);
    const done: CompletedAction = {
      type: "completed",
      icon,
      title: "Everything revoked",
      description: `No agent can pull from your bag on ${tx.cluster} any more.`,
      label: "Revoked",
    };
    return done;
  });
}
