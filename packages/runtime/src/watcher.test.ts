import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  type Signature,
  signBytes,
  type Transaction,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { approvalMessage, createPolicySigner, JUPITER_PROGRAM_ADDRESS } from "@syndromi/core";
import { createToolset } from "@syndromi/tools";
import { fakeContext, SOL_MINT, USDC_MAINNET } from "@syndromi/tools/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog, memorySink } from "./activity.js";
import type { ApprovedDraft, ServerClient } from "./server-client.js";
import { executeApprovals } from "./watcher.js";

let owner: KeyPairSigner;
let stranger: KeyPairSigner;
let agentSigner: KeyPairSigner;

/** Jupiter stub: sells `inAmount` (defaults to the requested amount). */
const jupiter = (inAmount?: string) =>
  vi.fn((url: string | URL | Request) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          inAmount: inAmount ?? new URL(String(url)).searchParams.get("amount"),
          outAmount: "96000000",
          otherAmountThreshold: "95000000",
          computeBudgetInstructions: [
            { programId: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data: "AxAnAAAAAAAA" },
          ],
          setupInstructions: [],
          swapInstruction: { programId: JUPITER_PROGRAM_ADDRESS, accounts: [], data: "" },
          cleanupInstruction: null,
          otherInstructions: [],
          addressesByLookupTableAddress: null,
        }),
    } as Response),
  );

beforeEach(async () => {
  owner = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  agentSigner = await generateKeyPairSigner();
});

async function approved(signer: KeyPairSigner = owner, overrides: Partial<ApprovedDraft> = {}) {
  const draft = {
    id: "d_1234abcd",
    agent: agentSigner.address,
    owner: owner.address,
    tool: "jupiter-swap",
    input: { from: "USDC", to: "SOL", amount: 15 },
    intent: {
      kind: "swap" as const,
      inputMint: USDC_MAINNET,
      inputAmount: 15_000_000n,
      outputMint: SOL_MINT,
    },
    decision: { verdict: "needs_approval" as const, reasons: [], usd: 15 },
    summary: "swap 15 USDC → ~0.096 SOL",
    usd: 15,
  };
  const text = await approvalMessage({
    draft,
    agentName: "yield-scout",
    summary: draft.summary,
    usd: 15,
    owner: owner.address,
    nonce: "n",
    issuedAt: new Date(),
  });
  const signature = getBase58Decoder().decode(
    await signBytes(signer.keyPair.privateKey, getUtf8Encoder().encode(text)),
  );
  return { ...draft, approvalText: text, approvalSignature: signature, ...overrides };
}

async function run(drafts: ApprovedDraft[], inAmount?: string) {
  const ctx = await fakeContext({
    agent: agentSigner.address,
    owner: owner.address as Address,
    jupiter: { fetch: jupiter(inAmount) },
  });
  const client = {
    approvals: vi.fn(async () => ({ drafts, topups: [] })),
    reportDraft: vi.fn(async (_id: string, _r: unknown) => ({})),
    reportTopUp: vi.fn(async () => ({})),
  };
  const send = vi.fn(async (_t: Transaction) => "sig999" as Signature);
  const sink = memorySink();
  const result = await executeApprovals({
    client: client as unknown as Pick<ServerClient, "approvals" | "reportDraft" | "reportTopUp">,
    agentName: "yield-scout",
    tools: createToolset(["jupiter-swap"]),
    signer: createPolicySigner({ signer: agentSigner, policy: ctx.policy, prices: ctx.prices }),
    ctx,
    log: new ActivityLog("yield-scout", [sink]),
    send,
  });
  return { result, client, send, sink };
}

describe("executeApprovals", () => {
  it("executes an owner-approved draft at a fresh quote and reports the signature", async () => {
    const { result, client, send } = await run([await approved()]);
    expect(result.executed).toEqual(["d_1234abcd"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.reportDraft).toHaveBeenCalledWith("d_1234abcd", {
      status: "executed",
      signature: "sig999",
    });
  });

  it("marks the draft stale when the fresh value exceeds the signed bound by more than 10%", async () => {
    const { result, client, send } = await run([await approved()], "20000000");
    expect(result.stale).toEqual(["d_1234abcd"]);
    expect(send).not.toHaveBeenCalled();
    expect(client.reportDraft.mock.calls[0]?.[1]).toMatchObject({ status: "stale" });
  });

  it("refuses approvals the owner did not sign, even if the server says approved", async () => {
    const { result, send, client } = await run([await approved(stranger)]);
    expect(result.failed).toEqual(["d_1234abcd"]);
    expect(send).not.toHaveBeenCalled();
    expect(client.reportDraft.mock.calls[0]?.[1]).toMatchObject({
      status: "failed",
      error: /signature does not match the owner/,
    });
  });

  it("refuses a draft the server changed after approval, or one for another agent", async () => {
    const tampered = await approved(owner);
    tampered.input = { from: "USDC", to: "SOL", amount: 25 };
    const other = await approved(owner, { agent: stranger.address });
    const { result, send, client } = await run([tampered, other]);
    expect(result.failed).toEqual(["d_1234abcd", "d_1234abcd"]);
    expect(send).not.toHaveBeenCalled();
    expect(client.reportDraft.mock.calls.map((c) => (c[1] as { error: string }).error)).toEqual([
      expect.stringMatching(/hash mismatch/),
      expect.stringMatching(/different agent/),
    ]);
  });
});
