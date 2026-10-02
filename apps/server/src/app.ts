import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mountApproveDraft } from "./actions/approve-draft.js";
import { mountApproveTopUp } from "./actions/approve-topup.js";
import { mountFundAgent } from "./actions/fund-agent.js";
import { mountKillSwitch } from "./actions/kill-switch.js";
import { mountSpec } from "./actions/spec.js";
import { mountAgentApi } from "./agent-api.js";
import { mountApi } from "./api.js";
import { mountApprovePage } from "./approve-page.js";
import type { ServerContext } from "./context.js";
import { mountOwner } from "./owner.js";
import { mountOwnerTx } from "./owner-tx.js";
import { WEBHOOK_PATH } from "./telegram.js";

export function createApp(ctx: ServerContext) {
  const app = new Hono();
  const icon = mountSpec(app, ctx.config.publicUrl);
  mountApproveDraft(app, ctx, icon);
  mountApproveTopUp(app, ctx, icon);
  mountFundAgent(app, ctx, icon);
  mountKillSwitch(app, ctx, icon);
  mountOwnerTx(app, ctx, icon);
  mountApprovePage(app, ctx);
  mountApi(app, ctx);
  mountOwner(app, ctx);
  mountAgentApi(app, ctx);
  recordApprovalEvents(ctx);
  // Telegram delivers updates here when the bot runs by webhook (it checks the secret header).
  app.post(WEBHOOK_PATH, async (c) =>
    ctx.telegram?.webhook ? await ctx.telegram.webhook(c) : c.text("not found", 404),
  );
  app.get("/", (c) => c.text("syndromi server"));
  return app;
}

/** Start the HTTP server; port 0 picks a free port (tests). */
export function listen(ctx: ServerContext, port: number) {
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = serve({ fetch: createApp(ctx).fetch, port }, (info) =>
      resolve({ port: info.port, close: () => server.close() }),
    );
  });
}

/** Status changes of drafts and top-ups become activity-feed events. */
function recordApprovalEvents(ctx: ServerContext) {
  const at = () => new Date().toISOString();
  const failed = (e: unknown) => console.error("activity:", (e as Error).message);
  ctx.bus.on("draft", (d) => {
    if (d.status === "pending") return; // the runtime already logged draft_created
    void ctx.store
      .addActivity(d.agentName, {
        type: "approval",
        at: at(),
        kind: "draft",
        id: d.id,
        status: d.status,
        summary: d.summary,
        cluster: d.cluster,
        ...(d.resultSignature ? { signature: d.resultSignature } : {}),
        ...(d.resultError ? { error: d.resultError } : {}),
      })
      .catch(failed);
  });
  ctx.bus.on("topup", (t) => {
    void ctx.store
      .addActivity(t.agentName, {
        type: "approval",
        at: at(),
        kind: "topup",
        id: t.id,
        status: t.status,
        summary: `top-up of ${Number(t.amount) / 1e6} USDC: ${t.reason}`,
        cluster: t.cluster,
        ...(t.resultSignature ? { signature: t.resultSignature } : {}),
      })
      .catch(failed);
  });
}
