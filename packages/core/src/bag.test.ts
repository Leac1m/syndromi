import { address, createClient, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { subscriptionsProgram } from "@solana/subscriptions";
import { describe, expect, it } from "vitest";
import {
  ensureSubscriptionAuthority,
  grantAllowance,
  grantTopUp,
  listDelegations,
  pullAllowance,
  pullTopUp,
  recurringRemaining,
  revokeAll,
} from "./bag.js";

describe("recurringRemaining", () => {
  const d = {
    currentPeriodStartTs: 1_000n,
    periodLengthS: 100n,
    expiryTs: 10_000n,
    amountPerPeriod: 50n,
    amountPulledInPeriod: 20n,
  };

  it("subtracts what was pulled in the current period", () => {
    expect(recurringRemaining(d, 1_050n)).toEqual({ remaining: 30n, periodEndsAt: 1_100n });
  });

  it("resets once the period has rolled over, however many periods passed", () => {
    expect(recurringRemaining(d, 1_100n)).toEqual({ remaining: 50n, periodEndsAt: 1_200n });
    expect(recurringRemaining(d, 1_350n)).toEqual({ remaining: 50n, periodEndsAt: 1_400n });
  });

  it("is zero after expiry and never negative", () => {
    expect(recurringRemaining(d, 10_000n).remaining).toBe(0n);
    expect(recurringRemaining({ ...d, amountPulledInPeriod: 80n }, 1_050n).remaining).toBe(0n);
  });
});

// End-to-end against the Subscriptions program on a Surfpool mainnet fork. Start it with:
//   surfpool start --no-tui --rpc-url "https://mainnet.helius-rpc.com/?api-key=$RPC_API_KEY"
const SURFPOOL = "http://127.0.0.1:8899";
const surfpoolUp = await fetch(SURFPOOL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  signal: AbortSignal.timeout(1000),
})
  .then((r) => r.ok)
  .catch(() => false);
if (!surfpoolUp) console.warn("bag integration test skipped: Surfpool is not running on :8899");

const cheatcode = (method: string, params: unknown[]) =>
  fetch(SURFPOOL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const fund = (owner: string, lamports: number) =>
  cheatcode("surfnet_setAccount", [owner, { lamports }]);
// Real mainnet USDC: creating a fresh mint on the fork hangs in Surfpool (see architecture.md).
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe.skipIf(!surfpoolUp)("bag on a Surfpool fork", () => {
  it("grants, pulls, tops up, lists, and revokes everything", { timeout: 60_000 }, async () => {
    const ownerSigner = await generateKeyPairSigner();
    const agentSigner = await generateKeyPairSigner();
    await fund(ownerSigner.address, 2_000_000_000);
    await fund(agentSigner.address, 100_000_000);

    const owner = createClient()
      .use(signer(ownerSigner))
      .use(solanaRpc({ rpcUrl: SURFPOOL }))
      .use(subscriptionsProgram());
    const agent = createClient()
      .use(signer(agentSigner))
      .use(solanaRpc({ rpcUrl: SURFPOOL }))
      .use(subscriptionsProgram());
    const send = (client: typeof owner | typeof agent, ixs: Instruction[]) =>
      client.sendTransaction(ixs);

    // The owner's bag holds 1,000 USDC; the Subscription Authority is set up once per mint.
    const mint = USDC;
    await cheatcode("surfnet_setTokenAccount", [
      ownerSigner.address,
      mint,
      { amount: 1_000_000_000 },
    ]);
    await send(owner, await ensureSubscriptionAuthority(owner, mint));
    expect(await ensureSubscriptionAuthority(owner, mint)).toEqual([]);

    // Allowance: 10 per day. The agent pulls 4 (also creating its own token account).
    await send(
      owner,
      await grantAllowance(owner, {
        agent: agentSigner.address,
        mint,
        amountPerPeriod: 10_000_000n,
        periodSeconds: 86_400,
      }),
    );
    await send(
      agent,
      await pullAllowance(agent, { owner: ownerSigner.address, mint, amount: 4_000_000n }),
    );

    let views = await listDelegations(owner.rpc, ownerSigner.address);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      kind: "allowance",
      limit: 10_000_000n,
      remaining: 6_000_000n,
    });

    // Two top-ups get distinct nonces; pulling from one reduces what's left on it.
    const first = await grantTopUp(owner, { agent: agentSigner.address, mint, amount: 5_000_000n });
    await send(owner, first.instructions);
    const second = await grantTopUp(owner, {
      agent: agentSigner.address,
      mint,
      amount: 1_000_000n,
    });
    await send(owner, second.instructions);
    expect([first.nonce, second.nonce]).toEqual([1n, 2n]);

    views = await listDelegations(owner.rpc, ownerSigner.address);
    const topUp = views.find((v) => v.kind === "top-up" && v.limit === 5_000_000n);
    if (!topUp) throw new Error("top-up not listed");
    await send(
      agent,
      await pullTopUp(agent, {
        owner: ownerSigner.address,
        mint,
        amount: 3_000_000n,
        delegation: topUp.address,
      }),
    );
    views = await listDelegations(owner.rpc, ownerSigner.address);
    expect(views.find((v) => v.address === topUp.address)?.remaining).toBe(2_000_000n);

    // Kill switch: every delegation revoked (hard: token approval cleared too); pulls fail.
    await owner.sendTransactions(await revokeAll(owner, { hard: true }));
    expect(await listDelegations(owner.rpc, ownerSigner.address)).toEqual([]);
    await expect(
      send(agent, await pullAllowance(agent, { owner: ownerSigner.address, mint, amount: 1n })),
    ).rejects.toThrow();
  });
});
