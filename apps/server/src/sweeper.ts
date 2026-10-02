// Background housekeeping: expire stale drafts and top-up requests, and confirm top-ups by
// looking for the delegation onchain (dial.to can report devnet transactions as unconfirmed,
// so the callback alone is not trusted to arrive).
import type { ServerContext } from "./context.js";
import { StatusChanged, type TopUpRecord } from "./db.js";

export async function checkTopUp(
  ctx: ServerContext,
  topup: TopUpRecord,
  signature?: string,
): Promise<TopUpRecord> {
  if (topup.status !== "pending" || !topup.delegation) return topup;
  const { value } = await ctx
    .rpc(topup.cluster)
    .getAccountInfo(topup.delegation, { encoding: "base64" })
    .send();
  if (!value) return topup;
  const approved = await ctx.store
    .updateTopUp(
      topup.id,
      { status: "approved", ...(signature ? { approvalSignature: signature } : {}) },
      ["pending"],
    )
    .catch(ignoreChanged);
  // Already confirmed (or expired) by someone else meanwhile: report what is stored now.
  if (!approved) return (await ctx.store.topUp(topup.id)) ?? topup;
  ctx.bus.emit("topup", approved);
  return approved;
}

export async function sweep(ctx: ServerContext, now = Date.now()) {
  const { store, bus } = ctx;
  for (const draft of await store.drafts({ status: "pending" })) {
    if (Date.parse(draft.expiresAt) < now) {
      // The owner may approve between the list and the update; leave it alone then.
      const expired = await store
        .updateDraft(draft.id, { status: "expired" }, ["pending"])
        .catch(ignoreChanged);
      if (expired) bus.emit("draft", expired);
    }
  }
  for (const topup of await store.topUps({ status: "pending" })) {
    if (topup.delegation) {
      const checked = await checkTopUp(ctx, topup).catch(() => topup);
      if (checked.status !== "pending") continue;
    }
    if (Date.parse(topup.expiresAt) < now) {
      const expired = await store
        .updateTopUp(topup.id, { status: "expired" }, ["pending"])
        .catch(ignoreChanged);
      if (expired) bus.emit("topup", expired);
    }
  }
}

function ignoreChanged(err: unknown): undefined {
  if (err instanceof StatusChanged) return undefined;
  throw err;
}

export function startSweeper(ctx: ServerContext, everyMs = 10_000) {
  const timer = setInterval(
    () => void sweep(ctx).catch((e) => console.error("sweep:", e)),
    everyMs,
  );
  return () => clearInterval(timer);
}
