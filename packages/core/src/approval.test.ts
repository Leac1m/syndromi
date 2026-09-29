import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getUtf8Encoder,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalMessage, type DraftCore, draftHash, verifyOwnerApproval } from "./approval.js";

let owner: KeyPairSigner;
let stranger: KeyPairSigner;
let draft: DraftCore;
const issuedAt = new Date("2026-10-02T12:00:00Z");

beforeAll(async () => {
  owner = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  draft = {
    id: "5773834a",
    agent: (await generateKeyPairSigner()).address,
    tool: "jupiter-swap",
    input: { from: "USDC", to: "JitoSOL", amount: 15 },
    intent: {
      kind: "swap",
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
      inputAmount: 15_000_000n,
    },
  };
});

const message = (d: DraftCore = draft) =>
  approvalMessage({
    draft: d,
    agentName: "yield-scout",
    summary: "swap 15 USDC → ~0.0966 JitoSOL",
    usd: 15,
    owner: owner.address,
    nonce: "n0nce",
    issuedAt,
  });
const sign = async (signer: KeyPairSigner, text: string) =>
  getBase58Decoder().decode(
    await signBytes(signer.keyPair.privateKey, getUtf8Encoder().encode(text)),
  );
const verify = (text: string, signature: string, d: DraftCore = draft, now = issuedAt) =>
  verifyOwnerApproval({ text, signature, owner: owner.address, draft: d, now });

describe("owner approvals", () => {
  it("hashes drafts canonically (key order and bigints do not matter)", async () => {
    const reordered = {
      intent: draft.intent,
      input: draft.input,
      tool: draft.tool,
      agent: draft.agent,
      id: draft.id,
    };
    expect(await draftHash(reordered)).toBe(await draftHash(draft));
    expect(
      await draftHash({ ...draft, input: { ...(draft.input as object), amount: 16 } }),
    ).not.toBe(await draftHash(draft));
  });

  it("accepts the owner's signature over the message and returns the signed USD bound", async () => {
    const text = await message();
    expect(text).toMatch(/at most \$15\.00/);
    expect(await verify(text, await sign(owner, text))).toEqual({
      ok: true,
      usd: 15,
      nonce: "n0nce",
      issuedAt,
    });
  });

  it("rejects a stranger's signature, a tampered message, a changed draft, and stale approvals", async () => {
    const text = await message();
    const good = await sign(owner, text);
    expect(await verify(text, await sign(stranger, text))).toMatchObject({
      ok: false,
      reason: "signature does not match the owner",
    });
    const raised = text.replace("at most $15.00", "at most $150.00");
    expect(await verify(raised, good)).toMatchObject({ ok: false, reason: /does not match/ });
    const changed = { ...draft, input: { from: "USDC", to: "JitoSOL", amount: 150 } };
    expect(await verify(text, good, changed)).toMatchObject({ ok: false, reason: /hash mismatch/ });
    expect(await verify(text, good, { ...draft, id: "other" })).toMatchObject({
      ok: false,
      reason: /different draft/,
    });
    const later = new Date(issuedAt.getTime() + 31 * 60 * 1000);
    expect(await verify(text, good, draft, later)).toMatchObject({
      ok: false,
      reason: "approval expired",
    });
    expect(await verify(text, "not-base58-!!")).toMatchObject({ ok: false });
  });
});
