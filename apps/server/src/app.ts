import { Hono } from "hono";
import { mountApproveDraft } from "./actions/approve-draft.js";
import { mountApproveTopUp } from "./actions/approve-topup.js";
import { mountSpec } from "./actions/spec.js";
import { mountApi } from "./api.js";
import type { ServerContext } from "./context.js";

export function createApp(ctx: ServerContext) {
  const app = new Hono();
  const icon = mountSpec(app, ctx.config.publicUrl);
  mountApproveDraft(app, ctx, icon);
  mountApproveTopUp(app, ctx, icon);
  mountApi(app, ctx);
  app.get("/", (c) => c.text("syndromi server"));
  return app;
}
