// Per-agent access tokens for the owner's AI (remote MCP and the HTTP API). A token is shown once,
// at creation; only its SHA-256 hash is stored. It reaches one agent, and everything it does still
// passes that agent's policy signer.
import { createHash, randomBytes } from "node:crypto";
import type { ServerContext } from "./context.js";
import type { AgentRecord, TokenRecord } from "./db.js";

export const TOKEN_PREFIX = "syn_";
/** The lifetimes an owner may pick, in days. There is deliberately no "never expires". */
export const TOKEN_LIFETIMES_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_TOKEN_DAYS = 30;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** `syn_` + 32 random bytes (256 bits), base64url. */
export const newTokenSecret = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** The first characters of a token: enough to tell tokens apart, useless for guessing. */
export const tokenPrefix = (token: string) => token.slice(0, TOKEN_PREFIX.length + 4);

/**
 * Create a token for `agent`. Returns the secret (the only time it exists in the clear) and its
 * stored record. Throws TokenLimit when the agent already has the maximum live.
 */
export async function createAgentToken(
  ctx: ServerContext,
  agent: AgentRecord,
  opts: { label?: string; days?: number },
  now = new Date(),
): Promise<{ token: string; record: TokenRecord }> {
  const days = opts.days ?? DEFAULT_TOKEN_DAYS;
  if (!(TOKEN_LIFETIMES_DAYS as readonly number[]).includes(days)) {
    throw new Error(`lifetime must be one of ${TOKEN_LIFETIMES_DAYS.join(", ")} days`);
  }
  const token = newTokenSecret();
  const record: TokenRecord = {
    id: `k_${randomBytes(6).toString("hex")}`,
    agentName: agent.name,
    owner: agent.owner,
    prefix: tokenPrefix(token),
    label: (opts.label ?? "").trim().slice(0, 40),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
  };
  await ctx.store.createToken(record, hashToken(token), now);
  return { token, record };
}

export type TokenCheck =
  | { ok: true; token: TokenRecord; agent: AgentRecord }
  | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired" | "agent" };

/** Look a presented token up. Not cached, so a revocation takes effect on the next request. */
export async function checkToken(
  ctx: ServerContext,
  presented: string,
  now = new Date(),
): Promise<TokenCheck> {
  if (!presented.startsWith(TOKEN_PREFIX) || presented.length > 200) {
    return { ok: false, reason: "malformed" };
  }
  const token = await ctx.store.tokenByHash(hashToken(presented));
  if (!token) return { ok: false, reason: "unknown" };
  if (token.revokedAt) return { ok: false, reason: "revoked" };
  if (Date.parse(token.expiresAt) <= now.getTime()) return { ok: false, reason: "expired" };
  const agent = await ctx.store.agent(token.agentName);
  if (!agent || agent.owner !== token.owner || agent.custody !== "server") {
    return { ok: false, reason: "agent" };
  }
  return { ok: true, token, agent };
}
