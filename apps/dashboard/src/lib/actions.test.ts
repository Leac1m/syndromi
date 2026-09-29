import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { type Card, runStep, type Signer } from "./actions";

const card = (href: string): Card => ({
  title: "t",
  description: "d",
  label: "go",
  links: { actions: [{ href, label: "go" }] },
});
const reply = (routes: Record<string, unknown>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (!body)
      return new Response(JSON.stringify({ message: `no route ${path}` }), { status: 404 });
    return new Response(JSON.stringify(typeof body === "function" ? body(init) : body));
  });

describe("runStep", () => {
  it("signs a message step and posts the signature to the next link", async () => {
    const signer: Signer = {
      account: "Owner1111111111111111111111111111111111111",
      signMessage: vi.fn(async () => new Uint8Array(64).fill(1)),
      signTransaction: vi.fn(),
    };
    const fetch = reply({
      "/actions/approve-draft/d_1": {
        type: "message",
        data: "syndromi approval …",
        state: "n",
        links: { next: { href: "/actions/approve-draft/d_1/verify" } },
      },
      "/actions/approve-draft/d_1/verify": {
        type: "completed",
        title: "Approved",
        description: "",
        label: "Approved",
      },
    });
    const next = await runStep("http://s", card("/actions/approve-draft/d_1"), signer, fetch);
    expect(next).toMatchObject({ type: "completed", title: "Approved" });
    expect(signer.signMessage).toHaveBeenCalledWith("syndromi approval …");
    const verifyBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(verifyBody).toMatchObject({ state: "n", data: "syndromi approval …" });
    expect(verifyBody.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("has the wallet only sign a transaction step, then submits it for the server to send", async () => {
    const owner = await generateKeyPairSigner();
    const tx = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(owner.address, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n },
            m,
          ),
        (m) => appendTransactionMessageInstructions([], m),
      ),
    );
    const wire = getBase64EncodedWireTransaction(tx);
    const signer: Signer = {
      account: owner.address,
      signMessage: vi.fn(),
      signTransaction: vi.fn(async () => new Uint8Array(getBase64Encoder().encode(wire))),
    };
    const fetch = reply({
      "/actions/fund-agent/dca": {
        type: "transaction",
        transaction: wire,
        links: { next: { href: "/actions/tx/x_1/confirm" } },
      },
      "/actions/tx/x_1/submit": {
        type: "action",
        title: "Step 2 of 2",
        description: "",
        label: "Sign & fund",
        links: { actions: [{ href: "/actions/fund-agent/dca", label: "Sign & fund" }] },
      },
    });
    const next = await runStep("http://s", card("/actions/fund-agent/dca"), signer, fetch);
    expect(next.title).toBe("Step 2 of 2");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe("/actions/tx/x_1/submit");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).transaction).toBe(wire);
  });

  it("surfaces the server's error message", async () => {
    const signer: Signer = { account: "x", signMessage: vi.fn(), signTransaction: vi.fn() };
    await expect(runStep("http://s", card("/actions/nope"), signer, reply({}))).rejects.toThrow(
      "no route /actions/nope",
    );
  });
});
