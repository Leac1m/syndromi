// Approve a held draft by signing a message (Actions sign-message flow):
//   GET  /actions/approve-draft/:id          → the card (what, how much, why it was held)
//   POST /actions/approve-draft/:id          → {type:"message", data:<approval text>, state:<nonce>}
//   POST /actions/approve-draft/:id/verify   → checks the owner's signature, marks it approved
import type {
  ActionGetResponse,
  CompletedAction,
  MessageNextActionPostRequest,
  SignMessageResponse,
} from "@solana/actions-spec";
import { approvalMessage, verifyOwnerApproval } from "@syndromi/core";
import type { Context, Hono } from "hono";
import type { ServerContext } from "../context.js";
import { type DraftRecord, StatusChanged } from "../db.js";
import { actionError, actionJson } from "./spec.js";

export function mountApproveDraft(app: Hono, ctx: ServerContext, icon: string) {
  const { store } = ctx;
  const path = (id: string) => `/actions/approve-draft/${id}`;

  const load = async (c: Context) => {
    const draft = await store.draft(c.req.param("id") ?? "");
    if (!draft) return { error: actionError(c, "No such draft", 404) };
    if (draft.status === "pending" && Date.parse(draft.expiresAt) < Date.now()) {
      const expired = await store
        .updateDraft(draft.id, { status: "expired" }, ["pending"])
        .catch(async (e) => {
          if (e instanceof StatusChanged) return (await store.draft(draft.id)) ?? draft;
          throw e;
        });
      return { draft: expired };
    }
    return { draft };
  };

  app.get(path(":id"), async (c) => {
    const { draft, error } = await load(c);
    if (!draft) return error;
    const agent = await store.agent(draft.agentName);
    const threshold = agent
      ? ` (above your $${agent.rules.approveAboveUsd} approval threshold)`
      : "";
    const body: ActionGetResponse = {
      type: "action",
      icon,
      title: `${draft.agentName} wants approval`,
      description:
        `${draft.summary}. Value $${draft.usd.toFixed(2)}${threshold}.\n` +
        `Signing approves only this draft; the agent re-quotes and executes if the value ` +
        `stays within 10%. Expires ${draft.expiresAt}.`,
      label: draft.status === "pending" ? "Approve" : statusLabel(draft),
      disabled: draft.status !== "pending",
      links: {
        actions: [{ type: "message", href: path(draft.id), label: "Approve (sign)" }],
      },
    };
    return actionJson(c, body, draft.cluster);
  });

  app.post(path(":id"), async (c) => {
    const { draft, error } = await load(c);
    if (!draft) return error;
    if (draft.status !== "pending") return actionError(c, `This draft is ${draft.status}.`, 409);
    const { account } = (await c.req.json().catch(() => ({}))) as { account?: string };
    if (account !== draft.owner) {
      return actionError(c, `Only the bag owner (${draft.owner}) can approve this draft.`, 403);
    }
    const nonce = crypto.randomUUID();
    const text = await approvalMessage({
      draft,
      agentName: draft.agentName,
      summary: draft.summary,
      usd: draft.usd,
      owner: draft.owner,
      nonce,
      issuedAt: new Date(),
    });
    await store.issueSignRequest(nonce, draft.id, text);
    const body: SignMessageResponse = {
      type: "message",
      data: text,
      state: nonce,
      links: { next: { type: "post", href: `${path(draft.id)}/verify` } },
    };
    return actionJson(c, body, draft.cluster);
  });

  app.post(`${path(":id")}/verify`, async (c) => {
    const { draft, error } = await load(c);
    if (!draft) return error;
    if (draft.status !== "pending") return actionError(c, `This draft is ${draft.status}.`, 409);
    const body = (await c.req.json().catch(() => ({}))) as Partial<MessageNextActionPostRequest>;
    const text = body.state ? await store.consumeSignRequest(body.state, draft.id) : undefined;
    if (!text) return actionError(c, "Unknown or already used approval request.", 400);
    if (typeof body.data === "string" && body.data !== text) {
      return actionError(c, "Signed data does not match the approval request.", 400);
    }
    if (body.account !== draft.owner || !body.signature) {
      return actionError(c, "Only the bag owner can approve this draft.", 403);
    }
    const check = await verifyOwnerApproval({
      text,
      signature: body.signature,
      owner: draft.owner,
      draft,
    });
    if (!check.ok) return actionError(c, `Approval rejected: ${check.reason}.`, 400);
    let approved: DraftRecord;
    try {
      approved = await store.updateDraft(
        draft.id,
        { status: "approved", approvalText: text, approvalSignature: body.signature },
        ["pending"], // it may have expired or been rejected while the owner was signing
      );
    } catch (e) {
      if (e instanceof StatusChanged) return actionError(c, `This draft is ${e.status}.`, 409);
      throw e;
    }
    ctx.bus.emit("draft", approved);
    const done: CompletedAction = {
      type: "completed",
      icon,
      title: "Approved",
      description: `${draft.agentName} will execute: ${draft.summary}.`,
      label: "Approved",
    };
    return actionJson(c, done, draft.cluster);
  });
}

const statusLabel = (d: DraftRecord) => d.status.charAt(0).toUpperCase() + d.status.slice(1);
