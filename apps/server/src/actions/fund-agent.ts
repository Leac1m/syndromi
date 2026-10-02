// Fund an agent: the owner's side of creating it, as one Action (dashboard wizard or Blink).
//   GET  /actions/fund-agent/:name  → card with the rule card
//   POST /actions/fund-agent/:name  → if the bag has no Subscription Authority for the mint yet:
//        a setup transaction, chained back to this Action (a grant can only be built once the
//        authority exists); otherwise: fee-budget top-up + recurring allowance, one transaction
import type { ActionGetResponse, CompletedAction } from "@solana/actions-spec";
import { type Address, createNoopSigner, lamports } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  ensureSubscriptionAuthority,
  grantAllowance,
  listDelegations,
  periodSeconds,
  toBaseUnits,
  tokenByMint,
} from "@syndromi/core";
import type { Context, Hono } from "hono";
import type { ServerContext } from "../context.js";
import type { AgentRecord } from "../db.js";
import { publicAgent } from "../owner.js";
import { issueOwnerTx, onOwnerTxLanded } from "../owner-tx.js";
import { actionError, actionJson } from "./spec.js";

export function mountFundAgent(app: Hono, ctx: ServerContext, icon: string) {
  const { store } = ctx;
  const path = (name: string) => `/actions/fund-agent/${encodeURIComponent(name)}`;

  const card = (agent: AgentRecord, note = ""): ActionGetResponse => ({
    type: "action",
    icon,
    title: `Fund ${agent.name}`,
    description: [...publicAgent(agent).ruleCard, note].filter(Boolean).join("\n"),
    label: "Sign & fund",
    links: { actions: [{ type: "transaction", href: path(agent.name), label: "Sign & fund" }] },
  });

  const load = async (c: Context) => {
    const agent = await store.agent(decodeURIComponent(c.req.param("name") ?? ""));
    return agent?.allowance && agent.feeBudgetSol !== undefined ? agent : undefined;
  };

  const route = "/actions/fund-agent/:name";

  app.get(route, async (c) => {
    const agent = await load(c);
    if (!agent) return actionError(c, "No such agent, or it has no allowance to grant.", 404);
    return actionJson(c, card(agent), agent.cluster);
  });

  app.post(route, async (c) => {
    const agent = await load(c);
    if (!agent?.allowance || agent.feeBudgetSol === undefined) {
      return actionError(c, "No such agent, or it has no allowance to grant.", 404);
    }
    const { account } = (await c.req.json().catch(() => ({}))) as { account?: string };
    if (account !== agent.owner) {
      return actionError(
        c,
        `Only the bag owner (${agent.owner}) can fund ${agent.name}.`,
        403,
        agent.cluster,
      );
    }
    const client = ctx.ownerClient(agent.cluster, agent.owner);
    try {
      const setup = await ensureSubscriptionAuthority(client, agent.allowanceMint);
      if (setup.length) {
        const response = await issueOwnerTx(ctx, {
          owner: agent.owner,
          cluster: agent.cluster,
          kind: "fund-setup",
          ref: agent.name,
          instructions: setup,
          message: `Step 1 of 2: let your bag grant allowances in ${symbol(agent.allowanceMint)} (once per token)`,
        });
        return actionJson(c, response, agent.cluster);
      }
      const instructions = [];
      const budget = toBaseUnits(agent.feeBudgetSol, 9);
      const { value: held } = await ctx.rpc(agent.cluster).getBalance(agent.address).send();
      if (held < budget) {
        instructions.push(
          getTransferSolInstruction({
            source: createNoopSigner(agent.owner),
            destination: agent.address,
            amount: lamports(budget - held),
          }),
        );
      }
      const existing = (await listDelegations(ctx.rpc(agent.cluster), agent.owner)).find(
        (d) =>
          d.agent === agent.address && d.kind === "allowance" && d.mint === agent.allowanceMint,
      );
      if (!existing) {
        const decimals = tokenByMint(agent.allowanceMint)?.decimals ?? 6;
        instructions.push(
          ...(await grantAllowance(client, {
            agent: agent.address,
            mint: agent.allowanceMint,
            amountPerPeriod: toBaseUnits(agent.allowance.amount, decimals),
            periodSeconds: periodSeconds(agent.allowance.period),
          })),
        );
      }
      if (!instructions.length)
        return actionError(c, `${agent.name} is already funded.`, 409, agent.cluster);
      const response = await issueOwnerTx(ctx, {
        owner: agent.owner,
        cluster: agent.cluster,
        kind: "fund",
        ref: agent.name,
        instructions,
        message: `Fund ${agent.name}: ${agent.allowance.amount} ${agent.allowance.mint} per ${agent.allowance.period.replace(/ly$/, "")} and ${agent.feeBudgetSol} SOL for fees`,
      });
      return actionJson(c, response, agent.cluster);
    } catch (e) {
      return actionError(
        c,
        `Could not build the funding transaction: ${(e as Error).message}`,
        500,
        agent.cluster,
      );
    }
  });

  // Setup landed: chain back to this Action for the grant.
  onOwnerTxLanded(ctx, "fund-setup", async (tx) => {
    const agent = await store.agent(tx.ref);
    if (!agent) return done("Set up", "Your bag can now grant allowances.");
    return card(agent, "Step 2 of 2: grant the allowance and send the fee budget.");
  });
  onOwnerTxLanded(ctx, "fund", async (tx) => {
    await ctx.store.addActivity(tx.ref, {
      type: "approval",
      at: new Date().toISOString(),
      kind: "fund",
      status: "funded",
      summary: `${tx.ref} funded by the owner`,
      cluster: tx.cluster,
      ...(tx.signature ? { signature: tx.signature } : {}),
    });
    return done("Funded", `${tx.ref} can now pull its allowance.`);
  });

  const done = (title: string, description: string): CompletedAction => ({
    type: "completed",
    icon,
    title,
    description,
    label: title,
  });
}

const symbol = (mint: Address) => tokenByMint(mint)?.symbol ?? "this token";
