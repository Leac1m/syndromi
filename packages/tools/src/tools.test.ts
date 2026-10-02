import { generateKeyPairSigner } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { evaluate, JUPITER_PROGRAM_ADDRESS } from "@syndromi/core";
import { expect, it, describe as suite, vi } from "vitest";
import { z } from "zod";
import { createToolset } from "./registry.js";
import { fakeContext, fakeRpc, policy, SOL_MINT, USDC_MAINNET } from "./test-helpers.js";
import { defineTool } from "./tool.js";
import { shortfallMessage } from "./tools/pull-allowance.js";

const ix = (programId: string, data = "") => ({ programId, accounts: [], data });
const buildResponse = {
  inAmount: "2990000", // Jupiter's number, deliberately not the 3 the model asked for
  outAmount: "25000000",
  otherAmountThreshold: "24750000",
  priceImpactPct: "0.0001",
  routePlan: [{ swapInfo: { label: "Raydium CLMM" } }],
  computeBudgetInstructions: [ix(COMPUTE_BUDGET_PROGRAM_ADDRESS, "AxAnAAAAAAAA")], // SetComputeUnitPrice
  setupInstructions: [],
  swapInstruction: ix(JUPITER_PROGRAM_ADDRESS),
  cleanupInstruction: null,
  otherInstructions: [],
  addressesByLookupTableAddress: null,
};
const jupiterFetch = () =>
  vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(buildResponse) } as Response),
  );

suite("toolset", () => {
  it("describes tools in the MCP shape", () => {
    const [swap] = createToolset(["jupiter-swap"]).describe();
    expect(swap?.name).toBe("jupiter-swap");
    expect(swap?.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["from", "to", "amount"]),
    });
  });

  it("refuses tools the manifest did not enable, and explains bad input", async () => {
    const ctx = await fakeContext();
    const tools = createToolset(["pyth-price"]);
    expect(await tools.call("propose-tx", {}, ctx)).toMatchObject({
      type: "error",
      error: expect.stringMatching(/not enabled/),
    });
    expect(await tools.call("pyth-price", { symbols: [] }, ctx)).toMatchObject({
      type: "error",
      error: expect.stringMatching(/invalid input for pyth-price: symbols/),
    });
  });

  it("discards transactions returned by a read tool", async () => {
    const ctx = await fakeContext();
    const rogue = defineTool({
      name: "balances",
      kind: "read",
      description: "pretends to read",
      input: z.object({}),
      run: async () => ({ type: "request", summary: "x", request: {} as never }),
    });
    const tools = createToolset(["balances"], { balances: rogue });
    expect(await tools.call("balances", {}, ctx)).toMatchObject({
      type: "error",
      error: expect.stringMatching(/read-only/),
    });
  });

  it("turns tool exceptions into errors the model can read", async () => {
    const ctx = await fakeContext();
    const out = await createToolset(["pyth-price"]).call("pyth-price", { symbols: ["DOGE"] }, ctx);
    expect(out).toMatchObject({
      type: "error",
      error: expect.stringMatching(/unknown token "DOGE"/),
    });
  });
});

suite("network hiccups", () => {
  const flaky = (failures: number, error: Error) => {
    let calls = 0;
    const tool = defineTool({
      name: "balances",
      kind: "read",
      description: "flaky",
      input: z.object({}),
      run: async () => {
        calls++;
        if (calls <= failures) throw error;
        return { type: "data", data: { ok: true } };
      },
    });
    return { toolset: createToolset(["balances"], { balances: tool }), calls: () => calls };
  };
  const networkError = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });

  it("retries a tool that hits a network error, then succeeds", async () => {
    const { toolset, calls } = flaky(2, networkError);
    const out = await toolset.call("balances", {}, await fakeContext());
    expect(out).toMatchObject({ type: "data" });
    expect(calls()).toBe(3);
  });

  it("gives up after three attempts and names the real cause", async () => {
    const { toolset, calls } = flaky(99, networkError);
    const out = await toolset.call("balances", {}, await fakeContext());
    expect(out).toEqual({
      type: "error",
      error: "balances failed: fetch failed (ECONNRESET: read ECONNRESET)",
    });
    expect(calls()).toBe(3);
  });

  it("does not retry a refusal", async () => {
    const { toolset, calls } = flaky(99, new Error("unknown token"));
    await toolset.call("balances", {}, await fakeContext());
    expect(calls()).toBe(1);
  });
});

suite("jupiter-swap", () => {
  it("takes the value at risk from Jupiter's inAmount, not the model's input", async () => {
    const fetch = jupiterFetch();
    const ctx = await fakeContext({ jupiter: { fetch } });
    const out = await createToolset(["jupiter-swap"]).call(
      "jupiter-swap",
      { from: "USDC", to: "SOL", amount: 3 },
      ctx,
    );
    if (out.type !== "proposal") throw new Error(`expected a proposal, got ${JSON.stringify(out)}`);
    expect(out.proposal.intent).toEqual({
      kind: "swap",
      inputMint: USDC_MAINNET,
      inputAmount: 2_990_000n,
      outputMint: SOL_MINT,
    });
    expect(out.proposal.message.feePayer.address).toBe(ctx.agent);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/amount=3000000.*dexes=Whirlpool/);
    // The fork's frozen pool copies drift from Jupiter's live quote: a 3% floor there only.
    expect(String(fetch.mock.calls[0]?.[0])).toContain("slippageBps=300");
    expect(out.summary).toMatch(/swap 2\.99 USDC → ~0\.025 SOL/);
    expect(out.simulationError).toBeUndefined();
    expect((await evaluate(out.proposal, policy, ctx.prices)).verdict).toBe("allow");
  });

  it("asks Jupiter for a simpler route when the first one does not fit in a transaction", async () => {
    const many = await Promise.all(
      Array.from({ length: 40 }, async () => (await generateKeyPairSigner()).address),
    );
    const oversized = {
      ...buildResponse,
      swapInstruction: {
        programId: JUPITER_PROGRAM_ADDRESS,
        accounts: many.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        data: "",
      },
    };
    const fetch = vi.fn((url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(String(url).includes("maxAccounts") ? buildResponse : oversized),
      } as Response),
    );
    const ctx = await fakeContext({ jupiter: { fetch } });
    const out = await createToolset(["jupiter-swap"]).call(
      "jupiter-swap",
      { from: "USDC", to: "SOL", amount: 3 },
      ctx,
    );
    expect(out.type).toBe("proposal");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain("maxAccounts=48");
  });

  it("is unavailable on devnet", async () => {
    const ctx = await fakeContext({ cluster: "devnet", network: "devnet" });
    const out = await createToolset(["jupiter-swap"]).call(
      "jupiter-swap",
      { from: "USDC", to: "SOL", amount: 3 },
      ctx,
    );
    expect(out).toMatchObject({ type: "error", error: expect.stringMatching(/mainnet-only/) });
  });

  it("still returns a proposal when simulation fails, flagged", async () => {
    const rpc = fakeRpc({
      simulateTransaction: () => ({
        value: { err: { InstructionError: [1, { Custom: 1 }] }, unitsConsumed: 5n, logs: ["boom"] },
      }),
    });
    const ctx = await fakeContext({ rpc, jupiter: { fetch: jupiterFetch() } });
    const out = await createToolset(["jupiter-swap"]).call(
      "jupiter-swap",
      { from: "USDC", to: "SOL", amount: 3 },
      ctx,
    );
    expect(out).toMatchObject({ type: "proposal", simulationError: expect.any(String) });
  });
});

suite("propose-tx", () => {
  it("builds the injection transfer, which the policy blocks", async () => {
    const ctx = await fakeContext();
    const attacker = (await generateKeyPairSigner()).address;
    const out = await createToolset(["propose-tx"]).call(
      "propose-tx",
      { token: "USDC", to: attacker, amount: 4 },
      ctx,
    );
    if (out.type !== "proposal") throw new Error(`expected a proposal, got ${JSON.stringify(out)}`);
    const decision = await evaluate(out.proposal, { ...policy, programs: ["token"] }, ctx.prices);
    expect(decision.verdict).toBe("block");
    const reasons = decision.reasons.join("\n");
    expect(reasons).toMatch(new RegExp(`token account for ${attacker} not in allowlist`));
    expect(reasons).toMatch(/token destination \S+ not in allowlist/);
  });

  it("rejects a destination that is not an address", async () => {
    const ctx = await fakeContext();
    const out = await createToolset(["propose-tx"]).call(
      "propose-tx",
      { token: "SOL", to: "my friend", amount: 1 },
      ctx,
    );
    expect(out).toMatchObject({
      type: "error",
      error: expect.stringMatching(/to: must be a Solana address/),
    });
  });
});

suite("request-topup", () => {
  it("returns an approval request, not a transaction", async () => {
    const ctx = await fakeContext();
    const out = await createToolset(["request-topup"]).call(
      "request-topup",
      { amount: 20, reason: "weekly allowance used up; SOL dipped" },
      ctx,
    );
    expect(out).toMatchObject({
      type: "request",
      request: { kind: "topup", mint: USDC_MAINNET, amount: 20_000_000n },
    });
  });
});

suite("yield-data", () => {
  it("reports prices and unknown APYs, and no pool text outside the injection demo", async () => {
    const ctx = await fakeContext();
    const out = await createToolset(["yield-data"]).call("yield-data", {}, ctx);
    if (out.type !== "data") throw new Error(JSON.stringify(out));
    const data = out.data as { lsts: { apy: unknown }[]; pools?: unknown };
    expect(data.lsts.every((l) => l.apy === null)).toBe(true);
    expect(data.pools).toBeUndefined();
  });

  it("returns the injection fixture only when the manifest turns the demo on", async () => {
    const ctx = await fakeContext({ demo: { injection: true } });
    const out = await createToolset(["yield-data"]).call("yield-data", {}, ctx);
    expect(JSON.stringify(out)).toMatch(
      /migration vault AhLo5HEVqYUwdoNrEWoEXtY4X9y9jd85LCbtVw1JQVig/,
    );
  });
});

suite("pull-allowance", () => {
  const view = (agent: string, remaining: bigint) => ({
    address: agent as never,
    kind: "allowance" as const,
    agent: agent as never,
    mint: USDC_MAINNET,
    limit: 5_000_000n,
    remaining,
    periodEndsAt: 1_790_000_000n,
    expiresAt: 0n,
  });

  it("says how much is left, and when it resets, instead of failing onchain", async () => {
    const ctx = await fakeContext();
    const at = { agent: ctx.agent, allowanceMint: USDC_MAINNET };
    expect(shortfallMessage([view(ctx.agent, 2_000_000n)], at, 2_000_000n, 6, "USDC")).toBe(
      undefined,
    );
    expect(shortfallMessage([view(ctx.agent, 2_000_000n)], at, 3_000_000n, 6, "USDC")).toBe(
      "Only 2 USDC left of your allowance this period. It resets 2026-09-21T14:13Z. " +
        "Pull at most 2 USDC. If you need more before then, ask the owner once with request-topup.",
    );
    expect(shortfallMessage([view(ctx.agent, 0n)], at, 1_000_000n, 6, "USDC")).toMatch(
      /^Your USDC allowance for this period is used up\. .*request-topup/,
    );
  });

  it("stops an agent that has no allowance, before building anything", async () => {
    const ctx = await fakeContext(); // fakeRpc has no delegations
    expect(
      await createToolset(["pull-allowance"]).call("pull-allowance", { amount: 1 }, ctx),
    ).toMatchObject({ type: "error", error: expect.stringMatching(/No allowance is set up/) });
  });
});
