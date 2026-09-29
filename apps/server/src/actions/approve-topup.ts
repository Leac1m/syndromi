// Approve a top-up by signing a transaction that creates a one-time fixed delegation:
//   GET  /actions/approve-topup/:id          → the card
//   POST /actions/approve-topup/:id          → {type:"transaction", transaction:<base64, unsigned>}
//   POST /actions/approve-topup/:id/confirm  → callback after it lands; the sweeper also checks
//   POST /actions/approve-topup/:id/submit   → our viewer's path: the wallet only signs and the
//        server sends it to the agent's cluster (wallets send on their own selected network)
import type {
  ActionGetResponse,
  CompletedAction,
  NextActionPostRequest,
  TransactionResponse,
} from "@solana/actions-spec";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { grantTopUp, sendAndConfirm, tokenByMint, toUiAmount } from "@syndromi/core";
import type { Context, Hono } from "hono";
import type { ServerContext } from "../context.js";
import { checkTopUp } from "../sweeper.js";
import { actionError, actionJson } from "./spec.js";

export const TOPUP_EXPIRY_S = 7 * 86_400;

export function mountApproveTopUp(app: Hono, ctx: ServerContext, icon: string) {
  const { store } = ctx;
  const path = (id: string) => `/actions/approve-topup/${id}`;

  const load = (c: Context) => {
    const topup = store.topUp(c.req.param("id") ?? "");
    if (!topup) return { error: actionError(c, "No such top-up request", 404) };
    if (topup.status === "pending" && Date.parse(topup.expiresAt) < Date.now()) {
      return { topup: store.updateTopUp(topup.id, { status: "expired" }) };
    }
    return { topup };
  };
  const amountText = (t: { mint: string; amount: bigint }) => {
    const token = tokenByMint(t.mint as never);
    return `${toUiAmount(t.amount, token?.decimals ?? 6)} ${token?.symbol ?? "tokens"}`;
  };

  app.get(path(":id"), (c) => {
    const { topup, error } = load(c);
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
    const { topup, error } = load(c);
    if (!topup) return error;
    if (topup.status !== "pending") return actionError(c, `This request is ${topup.status}.`, 409);
    const { account } = (await c.req.json().catch(() => ({}))) as { account?: string };
    if (account !== topup.owner) {
      return actionError(c, `Only the bag owner (${topup.owner}) can approve this top-up.`, 403);
    }
    const client = ctx.ownerClient(topup.cluster, topup.owner);
    let built: Awaited<ReturnType<typeof grantTopUp>>;
    try {
      built = await grantTopUp(client, {
        agent: topup.agent,
        mint: topup.mint,
        amount: topup.amount,
        expiresInSeconds: TOPUP_EXPIRY_S,
      });
    } catch (e) {
      return actionError(c, `Could not build the top-up: ${(e as Error).message}`, 500);
    }
    const { value: blockhash } = await ctx.rpc(topup.cluster).getLatestBlockhash().send();
    const transaction = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(topup.owner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(built.instructions, m),
      ),
    );
    store.updateTopUp(topup.id, {
      delegation: built.delegation,
      issuedMessage: getBase64Decoder().decode(transaction.messageBytes),
    });
    const body: TransactionResponse = {
      type: "transaction",
      transaction: getBase64EncodedWireTransaction(transaction),
      message: `Approve a one-time top-up of ${amountText(topup)} for ${topup.agentName}`,
      links: { next: { type: "post", href: `${path(topup.id)}/confirm` } },
    };
    return actionJson(c, body, topup.cluster);
  });

  app.post(`${path(":id")}/submit`, async (c) => {
    const { topup, error } = load(c);
    if (!topup) return error;
    if (topup.status !== "pending") return actionError(c, `This request is ${topup.status}.`, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: string;
      transaction?: string;
    };
    if (body.account !== topup.owner || !body.transaction || !topup.issuedMessage) {
      return actionError(c, "Request the transaction first, signed by the bag owner.", 400);
    }
    let signed: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
    try {
      signed = getTransactionDecoder().decode(getBase64Encoder().encode(body.transaction));
    } catch {
      return actionError(c, "Not a transaction.", 400);
    }
    // Only the exact message we issued may be sent, now carrying the owner's signature.
    if (getBase64Decoder().decode(signed.messageBytes) !== topup.issuedMessage) {
      return actionError(c, "This is not the transaction that was issued for this top-up.", 400);
    }
    let signature: string;
    try {
      signature = await sendAndConfirm(
        ctx.rpc(topup.cluster),
        signed as Parameters<typeof sendAndConfirm>[1],
      );
    } catch (e) {
      return actionError(c, `Sending failed: ${(e as Error).message}`, 502);
    }
    const updated = await checkTopUp(ctx, store.topUp(topup.id) ?? topup, signature);
    const done: CompletedAction = {
      type: "completed",
      icon,
      title: updated.status === "approved" ? "Top-up approved" : "Sent, confirming…",
      description: `${topup.agentName} can now pull ${amountText(topup)}. Transaction ${signature}.`,
      label: updated.status === "approved" ? "Approved" : "Confirming",
    };
    return actionJson(c, done, topup.cluster);
  });

  app.post(`${path(":id")}/confirm`, async (c) => {
    const { topup, error } = load(c);
    if (!topup) return error;
    const body = (await c.req.json().catch(() => ({}))) as Partial<NextActionPostRequest>;
    const updated = await checkTopUp(ctx, topup, body.signature);
    const done: CompletedAction = {
      type: "completed",
      icon,
      title: updated.status === "approved" ? "Top-up approved" : "Confirming…",
      description:
        updated.status === "approved"
          ? `${topup.agentName} can now pull ${amountText(topup)}.`
          : "Waiting for the transaction to land; you'll get a Telegram confirmation.",
      label: updated.status === "approved" ? "Approved" : "Confirming",
    };
    return actionJson(c, done, topup.cluster);
  });
}
