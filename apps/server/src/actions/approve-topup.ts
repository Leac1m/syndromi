// Approve a top-up by signing a transaction that creates a one-time fixed delegation:
//   GET  /actions/approve-topup/:id  → the card
//   POST /actions/approve-topup/:id  → an owner transaction (see owner-tx.ts); once it lands the
//                                      top-up is approved (the sweeper also checks onchain)
import type { ActionGetResponse, CompletedAction } from "@solana/actions-spec";
import { grantTopUp, tokenByMint, toUiAmount } from "@syndromi/core";
import type { Context, Hono } from "hono";
import type { ServerContext } from "../context.js";
import { StatusChanged } from "../db.js";
import { issueOwnerTx, onOwnerTxLanded } from "../owner-tx.js";
import { checkTopUp } from "../sweeper.js";
import { actionError, actionJson } from "./spec.js";

export const TOPUP_EXPIRY_S = 7 * 86_400;

export const amountText = (t: { mint: string; amount: bigint }) => {
  const token = tokenByMint(t.mint as never);
  return `${toUiAmount(t.amount, token?.decimals ?? 6)} ${token?.symbol ?? "tokens"}`;
};

export function mountApproveTopUp(app: Hono, ctx: ServerContext, icon: string) {
  const { store } = ctx;
  const path = (id: string) => `/actions/approve-topup/${id}`;

  const load = async (c: Context) => {
    const topup = await store.topUp(c.req.param("id") ?? "");
    if (!topup) return { error: actionError(c, "No such top-up request", 404) };
    if (topup.status === "pending" && Date.parse(topup.expiresAt) < Date.now()) {
      const expired = await store
        .updateTopUp(topup.id, { status: "expired" }, ["pending"])
        .catch(async (e) => {
          if (e instanceof StatusChanged) return (await store.topUp(topup.id)) ?? topup;
          throw e;
        });
      return { topup: expired };
    }
    return { topup };
  };

  app.get(path(":id"), async (c) => {
    const { topup, error } = await load(c);
    if (!topup) return error;
    const fork = topup.cluster === "fork" ? " (fork agent: approve with `syndromi approve`)" : "";
    const body: ActionGetResponse = {
      type: "action",
      icon,
      title: `${topup.agentName} asks for a top-up`,
      description:
        `${amountText(topup)}, one time, on top of its allowance. Reason: ${topup.reason}\n` +
        `Signing creates a fixed delegation the agent can pull once within 7 days${fork}.`,
      label: topup.status === "pending" ? `Approve ${amountText(topup)}` : topup.status,
      disabled: topup.status !== "pending",
      links: {
        actions: [
          { type: "transaction", href: path(topup.id), label: `Approve ${amountText(topup)}` },
        ],
      },
    };
    return actionJson(c, body, topup.cluster);
  });

  app.post(path(":id"), async (c) => {
    const { topup, error } = await load(c);
    if (!topup) return error;
    if (topup.status !== "pending") return actionError(c, `This request is ${topup.status}.`, 409);
    const { account } = (await c.req.json().catch(() => ({}))) as { account?: string };
    if (account !== topup.owner) {
      return actionError(c, `Only the bag owner (${topup.owner}) can approve this top-up.`, 403);
    }
    try {
      const built = await grantTopUp(ctx.ownerClient(topup.cluster, topup.owner), {
        agent: topup.agent,
        mint: topup.mint,
        amount: topup.amount,
        expiresInSeconds: TOPUP_EXPIRY_S,
      });
      await store.updateTopUp(topup.id, { delegation: built.delegation });
      const response = await issueOwnerTx(ctx, {
        owner: topup.owner,
        cluster: topup.cluster,
        kind: "topup",
        ref: topup.id,
        instructions: built.instructions,
        message: `Approve a one-time top-up of ${amountText(topup)} for ${topup.agentName}`,
      });
      return actionJson(c, response, topup.cluster);
    } catch (e) {
      return actionError(c, `Could not build the top-up: ${(e as Error).message}`, 500);
    }
  });

  onOwnerTxLanded(ctx, "topup", async (tx, signature) => {
    const topup = await store.topUp(tx.ref);
    const updated = topup ? await checkTopUp(ctx, topup, signature) : undefined;
    const approved = updated?.status === "approved";
    const done: CompletedAction = {
      type: "completed",
      icon,
      title: approved ? "Top-up approved" : "Confirming…",
      description:
        approved && topup
          ? `${topup.agentName} can now pull ${amountText(topup)}.`
          : "Waiting for the transaction to land; you'll get a Telegram confirmation.",
      label: approved ? "Approved" : "Confirming",
    };
    return done;
  });
}
