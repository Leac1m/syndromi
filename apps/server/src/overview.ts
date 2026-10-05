// What an owner sees of their wallet and agents on one cluster: balances, each agent with what is
// left of its allowance, and what waits for approval. The dashboard's overview and the Telegram
// bot's /status are both this, so they can never disagree.
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type Cluster,
  decimalsOf,
  findToken,
  listDelegations,
  mintFor,
  networkOf,
  toUiAmount,
} from "@syndromi/core";
import { FAUCET_WINDOW_MS, faucetAmount } from "./beta/faucet.js";
import type { ServerContext } from "./context.js";
import { publicAgent } from "./owner.js";

export async function buildOverview(ctx: ServerContext, who: Address, cluster: Cluster) {
  const { store, config } = ctx;
  const rpc = ctx.rpc(cluster);
  const usdc = findToken("USDC", networkOf(cluster));
  const usdcMint = usdc ? mintFor(usdc, networkOf(cluster)) : undefined;
  const [sol, bag, delegations] = await Promise.all([
    rpc
      .getBalance(who)
      .send()
      .then((r) => r.value)
      .catch(() => 0n),
    usdcMint
      ? findAssociatedTokenPda({
          owner: who,
          mint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
          .then(([ata]) => rpc.getTokenAccountBalance(ata).send())
          .then((r) => BigInt(r.value.amount))
          .catch(() => 0n)
      : Promise.resolve(0n),
    listDelegations(rpc, who).catch(() => []),
  ]);
  const [ownAgents, drafts, topups] = await Promise.all([
    store.agents(who),
    store.drafts({ status: "pending" }),
    store.topUps({ status: "pending" }),
  ]);
  const agents = ownAgents.filter((a) => a.cluster === cluster);
  const pendingDrafts = drafts.filter((d) => d.owner === who && d.cluster === cluster);
  const pendingTopUps = topups.filter((t) => t.owner === who && t.cluster === cluster);
  const perPeriod: Record<string, number> = {};
  const view = agents.map((a) => {
    const own = delegations.filter((d) => d.agent === a.address);
    const allowance = own.find((d) => d.kind === "allowance");
    if (allowance && a.allowance) {
      perPeriod[a.allowance.period] = (perPeriod[a.allowance.period] ?? 0) + a.allowance.amount;
    }
    return {
      ...publicAgent(a),
      funded: Boolean(allowance),
      nextRun: a.runtime === "hosted" ? (ctx.hosted?.nextRun?.(a.name)?.getTime() ?? null) : null,
      allowanceLeft: allowance
        ? {
            remaining: toUiAmount(allowance.remaining, decimalsOf(allowance.mint)),
            limit: toUiAmount(allowance.limit, decimalsOf(allowance.mint)),
            periodEndsAt: allowance.periodEndsAt
              ? Number(allowance.periodEndsAt) * 1000
              : undefined,
          }
        : undefined,
      topUps: own
        .filter((d) => d.kind === "top-up")
        .map((d) => ({
          remaining: toUiAmount(d.remaining, decimalsOf(d.mint)),
          expiresAt: Number(d.expiresAt) * 1000,
        })),
      pending:
        pendingDrafts.filter((d) => d.agentName === a.name).length +
        pendingTopUps.filter((t) => t.agentName === a.name).length,
    };
  });
  return {
    owner: who,
    cluster,
    bag: {
      usdc: toUiAmount(bag, usdc?.decimals ?? 6),
      sol: toUiAmount(sol, 9),
      usdcMint,
      symbol: usdc?.symbol ?? "USDC",
    },
    // Devnet only: syndromí's own test tokens, handed out by the treasury (beta/faucet.ts).
    ...(cluster === "devnet" && ctx.treasury
      ? {
          faucet: {
            amount: faucetAmount(config.env),
            nextAt: (await store.nextFaucetClaim(who, FAUCET_WINDOW_MS)) ?? null,
          },
        }
      : {}),
    allocatedPerPeriod: perPeriod,
    agents: view,
    pending: {
      drafts: pendingDrafts.map((d) => ({
        id: d.id,
        agentName: d.agentName,
        summary: d.summary,
        usd: d.usd,
        expiresAt: d.expiresAt,
        reasons: d.decision.reasons,
      })),
      topups: pendingTopUps.map((t) => ({
        id: t.id,
        agentName: t.agentName,
        amount: toUiAmount(t.amount, decimalsOf(t.mint)),
        reason: t.reason,
        expiresAt: t.expiresAt,
      })),
    },
  };
}

export type OwnerOverview = Awaited<ReturnType<typeof buildOverview>>;
