// Pausing: the owner's quick stop for one agent, without revoking anything onchain. The server
// only enforces it for agents whose key it holds (hosted, and server-held external agents).
// Pausing tightens, so it needs no signature and Telegram may do it; resuming loosens, so only a
// signed-in owner in the dashboard can.
import type { ServerContext } from "./context.js";
import type { AgentRecord } from "./db.js";

/** Whether the server is what runs or signs for this agent, and so can pause it. */
export const canPause = (agent: AgentRecord) =>
  agent.runtime === "hosted" || (agent.runtime === "external" && agent.custody === "server");

export const WHY_NOT_PAUSABLE =
  "holds its own key and runs on your machine, so the server cannot pause it; the kill switch revokes its allowance";

export async function setPaused(
  ctx: ServerContext,
  agent: AgentRecord,
  paused: boolean,
  from: "the dashboard" | "Telegram",
): Promise<{ agent: AgentRecord; changed: boolean }> {
  const result = await ctx.store.setAgentPaused(agent.name, paused);
  if (!result) return { agent, changed: false };
  if (result.changed) {
    await ctx.store.addActivity(agent.name, {
      type: "approval",
      at: new Date().toISOString(),
      kind: "pause",
      status: paused ? "paused" : "resumed",
      summary: paused
        ? `paused from ${from}: it will not run or act until you resume it`
        : `resumed from ${from}`,
      cluster: agent.cluster,
    });
  }
  return result;
}
