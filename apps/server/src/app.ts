import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mountApproveDraft } from "./actions/approve-draft.js";
import { mountApproveTopUp } from "./actions/approve-topup.js";
import { mountSpec } from "./actions/spec.js";
import { mountApi } from "./api.js";
import { mountApprovePage } from "./approve-page.js";
import type { ServerContext } from "./context.js";

export function createApp(ctx: ServerContext) {
  const app = new Hono();
  const icon = mountSpec(app, ctx.config.publicUrl);
  mountApproveDraft(app, ctx, icon);
  mountApproveTopUp(app, ctx, icon);
  mountApprovePage(app, ctx);
  mountApi(app, ctx);
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
