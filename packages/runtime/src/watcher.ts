// Executes what the owner approved, without the LLM. For each approved draft: re-verify the
// owner's signature here (the server is not trusted to vouch for it), re-run the tool for a fresh
// quote, re-check the policy, and send only if the value stays within 10% of what was signed.
// For each approved top-up: pull it into the agent's wallet through the policy signer.
import type { Signature, Transaction } from "@solana/kit";
import {
  errorDetail,
  explorerTx,
  isTransientNetworkError,
  type PolicySigner,
  pullTopUp,
  verifyOwnerApproval,
} from "@syndromi/core";
import { buildMessage, type ToolContext, type Toolset } from "@syndromi/tools";
import type { ActivityLog } from "./activity.js";
import type { ServerClient } from "./server-client.js";

export const MAX_DRIFT = 1.1;
/** Passes a failing simulation is retried (with a fresh quote each time) before giving up. */
export const SIMULATION_ATTEMPTS = 3;

export type WatchResult = {
  executed: string[];
  stale: string[];
  failed: string[];
  pulled: string[];
};

export async function executeApprovals(opts: {
  client: Pick<ServerClient, "approvals" | "reportDraft" | "reportTopUp">;
  agentName: string;
  tools: Toolset;
  signer: PolicySigner;
  ctx: ToolContext;
  log: ActivityLog;
  send: (signed: Transaction) => Promise<Signature>;
  now?: Date;
  /** Simulation failures per draft and network failures per top-up, kept by the caller across passes. */
  attempts?: Map<string, number>;
}): Promise<WatchResult> {
  const { client, ctx, log } = opts;
  const result: WatchResult = { executed: [], stale: [], failed: [], pulled: [] };
  const { drafts, topups } = await client.approvals(opts.agentName);

  for (const draft of drafts) {
    const fail = async (error: string) => {
      result.failed.push(draft.id);
      await log.emit("error", {
        draftId: draft.id,
        message: `approved draft ${draft.id}: ${error}`,
      });
      await client.reportDraft(draft.id, { status: "failed", error });
    };
    if (draft.agent !== ctx.agent) {
      await fail("draft belongs to a different agent");
      continue;
    }
    // The owner we trust is the one this agent was funded by, not whatever the server says.
    const check = await verifyOwnerApproval({
      text: draft.approvalText,
      signature: draft.approvalSignature,
      owner: ctx.owner,
      draft,
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!check.ok) {
      await fail(`approval rejected by the runtime: ${check.reason}`);
      continue;
    }
    const outcome = await opts.tools.call(draft.tool, draft.input, ctx);
    if (outcome.type !== "proposal") {
      await fail(
        outcome.type === "error" ? outcome.error : `${draft.tool} returned no transaction`,
      );
      continue;
    }
    const { intent } = outcome.proposal;
    if (
      intent.inputMint !== draft.intent.inputMint ||
      intent.outputMint !== draft.intent.outputMint
    ) {
      await fail("the re-built transaction moves different tokens than the approved draft");
      continue;
    }
    const signed = await opts.signer.sign(outcome.proposal, { approvedDraftId: draft.id });
    const { decision } = signed;
    await log.emit("decision", {
      tool: draft.tool,
      draftId: draft.id,
      verdict: decision.verdict,
      reasons: decision.reasons,
      usd: decision.usd,
      summary: `approved: ${outcome.summary}`,
    });
    if (decision.verdict === "block") {
      await fail(`policy blocks it now: ${decision.reasons.join("; ")}`);
      continue;
    }
    if ((decision.usd ?? 0) > check.usd * MAX_DRIFT) {
      result.stale.push(draft.id);
      const error = `value $${decision.usd?.toFixed(2)} exceeds the approved $${check.usd.toFixed(2)} by more than 10%`;
      await log.emit("error", {
        draftId: draft.id,
        message: `approved draft ${draft.id} is stale: ${error}`,
      });
      await client.reportDraft(draft.id, { status: "stale", error });
      continue;
    }
    if (outcome.simulationError) {
      const tries = (opts.attempts?.get(draft.id) ?? 0) + 1;
      opts.attempts?.set(draft.id, tries);
      if (opts.attempts && tries < SIMULATION_ATTEMPTS) {
        await log.emit("error", {
          draftId: draft.id,
          message: `approved draft ${draft.id}: simulation failed (try ${tries}/${SIMULATION_ATTEMPTS}), retrying with a fresh quote: ${outcome.simulationError}`,
        });
        continue;
      }
      await fail(outcome.simulationError);
      continue;
    }
    if (!signed.transaction) {
      await fail("the signer returned no transaction");
      continue;
    }
    try {
      const signature = await opts.send(signed.transaction);
      result.executed.push(draft.id);
      await log.emit("tx_sent", {
        tool: draft.tool,
        draftId: draft.id,
        signature,
        summary: outcome.summary,
        explorer: explorerTx(signature, ctx.cluster),
      });
      await client.reportDraft(draft.id, { status: "executed", signature });
    } catch (error) {
      await fail(`send failed: ${errorDetail(error)}`);
    }
  }

  for (const topup of topups) {
    try {
      if (topup.owner !== ctx.owner) throw new Error("top-up is from a different owner");
      const instructions = await pullTopUp(ctx.bag, {
        owner: ctx.owner,
        mint: topup.mint,
        amount: topup.amount,
        delegation: topup.delegation,
      });
      const { message, simulationError } = await buildMessage(ctx, instructions);
      if (simulationError) throw new Error(simulationError);
      const signed = await opts.signer.sign({
        agent: ctx.agent,
        tool: "pull-topup",
        message,
        intent: { kind: "pull", inputMint: topup.mint, inputAmount: topup.amount },
      });
      if (!signed.transaction) throw new Error(`policy: ${signed.decision.reasons.join("; ")}`);
      const signature = await opts.send(signed.transaction);
      result.pulled.push(topup.id);
      await log.emit("tx_sent", {
        tool: "pull-topup",
        topupId: topup.id,
        signature,
        summary: `pulled a top-up of ${topup.amount} base units`,
        explorer: explorerTx(signature, ctx.cluster),
      });
      await client.reportTopUp(topup.id, { status: "pulled", signature });
    } catch (error) {
      const message = errorDetail(error);
      const tries = (opts.attempts?.get(topup.id) ?? 0) + 1;
      opts.attempts?.set(topup.id, tries);
      if (opts.attempts && tries < SIMULATION_ATTEMPTS && isTransientNetworkError(error)) {
        await log.emit("error", {
          topupId: topup.id,
          message: `top-up ${topup.id}: ${message} (try ${tries}/${SIMULATION_ATTEMPTS}), retrying`,
        });
        continue;
      }
      result.failed.push(topup.id);
      await log.emit("error", {
        topupId: topup.id,
        message: `top-up ${topup.id}: ${message}`,
      });
      await client.reportTopUp(topup.id, { status: "failed", error: (error as Error).message });
    }
  }
  return result;
}
